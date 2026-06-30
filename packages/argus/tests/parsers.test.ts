import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { initAllParsers, parseFile } from "../src/extraction/parsers/registry.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

describe("tree-sitter parsers", () => {
  it("parse básico de fixture TS sem throw", () => {
    const source = readFileSync(join(fixturesDir, "sample.ts"), "utf-8");
    const { rootNode } = parseFile("typescript", source);
    expect(rootNode.type).toBe("program");
  });

  it("parse básico de fixture Python sem throw", () => {
    const source = readFileSync(join(fixturesDir, "sample.py"), "utf-8");
    const { rootNode } = parseFile("python", source);
    expect(rootNode.type).toBe("module");
  });

  it("inicializa parser Dart via wasm", async () => {
    await initAllParsers();
    const source = readFileSync(join(fixturesDir, "sample.dart"), "utf-8");
    const { rootNode } = parseFile("dart", source);
    expect(rootNode.type).toBe("program");
  });
});
