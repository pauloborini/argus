import { describe, expect, it } from "vitest";
import { countTokens } from "../src/packing/tokenizer.js";

describe("countTokens", () => {
  it("returns 0 for empty string", () => {
    expect(countTokens("")).toBe(0);
  });

  it("counts simple words", () => {
    expect(countTokens("hello world")).toBe(2);
  });

  it("splits camelCase into subtokens", () => {
    // camel(1) + Case(1) + Identifier(ceil(10/6)=2) = 4
    expect(countTokens("camelCaseIdentifier")).toBe(4);
  });

  it("counts punctuation as individual tokens", () => {
    expect(countTokens("({[]})")).toBe(6);
  });

  it("handles code with mixed content", () => {
    const code = "function foo() { return 1; }";
    const tokens = countTokens(code);
    // function(1) + foo(1) + ((1) + )(1) + {(1) + return(1) + 1(1) + ;(1) + }(1) = ~9
    expect(tokens).toBeGreaterThanOrEqual(7);
    expect(tokens).toBeLessThanOrEqual(15);
  });

  it("splits long identifiers into subwords", () => {
    // "internationalization" = 20 chars → ceil(20/6) = 4
    expect(countTokens("internationalization")).toBe(4);
  });

  it("handles numbers as single tokens", () => {
    expect(countTokens("42 100 999")).toBe(3);
  });
});
