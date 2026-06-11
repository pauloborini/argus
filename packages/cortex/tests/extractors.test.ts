import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { extractGo } from "../src/extraction/extractors/go.js";
import { extractJava } from "../src/extraction/extractors/java.js";
import { extractPython } from "../src/extraction/extractors/python.js";
import { extractRust } from "../src/extraction/extractors/rust.js";
import { extractTypeScriptLike } from "../src/extraction/extractors/typescript.js";
import { initAllParsers, parseFile } from "../src/extraction/parsers/registry.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

describe("extractors core", () => {
  beforeAll(async () => {
    await initAllParsers();
  });

  it("extrai função, classe, import e edges em TypeScript", () => {
    const source = readFileSync(join(fixturesDir, "sample.ts"), "utf-8");
    const { rootNode } = parseFile("typescript", source);
    const result = extractTypeScriptLike(rootNode);

    expect(result.symbols.some((s) => s.name === "foo" && s.kind === "function")).toBe(true);
    expect(result.symbols.some((s) => s.name === "Baz" && s.kind === "class")).toBe(true);
    expect(result.imports.some((i) => i.source.includes("bar"))).toBe(true);
    expect(result.edges.some((e) => e.kind === "extends")).toBe(true);
    expect(result.edges.some((e) => e.kind === "implements")).toBe(true);
    expect(result.parse_errors).toHaveLength(0);
  });

  it("extrai classe, função e import em Python", () => {
    const source = readFileSync(join(fixturesDir, "sample.py"), "utf-8");
    const { rootNode } = parseFile("python", source);
    const result = extractPython(rootNode);

    expect(result.symbols.some((s) => s.name === "Dog" && s.kind === "class")).toBe(true);
    expect(result.imports.length).toBeGreaterThan(0);
    expect(result.edges.some((e) => e.kind === "imports")).toBe(true);
  });

  it("extrai função e import em Go", () => {
    const source = readFileSync(join(fixturesDir, "sample.go"), "utf-8");
    const { rootNode } = parseFile("go", source);
    const result = extractGo(rootNode);

    expect(result.symbols.some((s) => s.name === "Foo")).toBe(true);
    expect(result.imports.some((i) => i.source === "fmt")).toBe(true);
  });

  it("extrai classe e import em Java", () => {
    const source = readFileSync(join(fixturesDir, "sample.java"), "utf-8");
    const { rootNode } = parseFile("java", source);
    const result = extractJava(rootNode);

    expect(result.symbols.some((s) => s.name === "Sample" && s.kind === "class")).toBe(true);
    expect(result.imports.some((i) => i.source.includes("java.util"))).toBe(true);
    expect(result.edges.some((e) => e.kind === "extends" || e.kind === "implements")).toBe(true);
  });

  it("extrai função, struct e use em Rust", () => {
    const source = readFileSync(join(fixturesDir, "sample.rs"), "utf-8");
    const { rootNode } = parseFile("rust", source);
    const result = extractRust(rootNode);

    expect(result.symbols.some((s) => s.name === "foo")).toBe(true);
    expect(result.symbols.some((s) => s.name === "Bar")).toBe(true);
    expect(result.imports.some((i) => i.source.includes("std"))).toBe(true);
  });
});
