import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { extractDart } from "../src/extraction/extractors/dart.js";
import { extractKotlin } from "../src/extraction/extractors/kotlin.js";
import { initAllParsers, parseFile } from "../src/extraction/parsers/registry.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

describe("extractors kotlin e dart", () => {
  beforeAll(async () => {
    await initAllParsers();
  });

  it("extrai classe, função e import em Kotlin", () => {
    const source = readFileSync(join(fixturesDir, "sample.kt"), "utf-8");
    const { rootNode } = parseFile("kotlin", source);
    const result = extractKotlin(rootNode);

    expect(result.symbols.some((s) => s.name === "A" && s.kind === "class")).toBe(true);
    expect(result.symbols.some((s) => s.name === "f" && s.kind === "function")).toBe(true);
    expect(result.imports.some((i) => i.source.includes("foo"))).toBe(true);
  });

  it("extrai classe, método e import em Dart", () => {
    const source = readFileSync(join(fixturesDir, "sample.dart"), "utf-8");
    const { rootNode } = parseFile("dart", source);
    const result = extractDart(rootNode);

    expect(result.symbols.some((s) => s.name === "A" && s.kind === "class")).toBe(true);
    expect(result.symbols.some((s) => s.name === "m" && s.kind === "function")).toBe(true);
    expect(result.imports.some((i) => i.source.includes("dart:io"))).toBe(true);
    expect(result.edges.some((e) => e.kind === "extends" || e.kind === "implements")).toBe(true);
  });

  it("extrai mixin, typedef, const top-level e relação with em Dart", () => {
    const source = readFileSync(join(fixturesDir, "sample.dart"), "utf-8");
    const { rootNode } = parseFile("dart", source);
    const result = extractDart(rootNode);

    // mixin como símbolo navegável (Flutter usa mixins fortemente)
    expect(result.symbols.some((s) => s.name === "Disposable" && s.kind === "class")).toBe(true);
    // typedef
    expect(result.symbols.some((s) => s.name === "IntCallback" && s.kind === "type")).toBe(true);
    // const/final top-level
    expect(result.symbols.some((s) => s.name === "kPadding" && s.kind === "variable")).toBe(true);
    expect(result.symbols.some((s) => s.name === "config" && s.kind === "variable")).toBe(true);
    // `class A with Disposable` vira implements para impact/trace
    expect(
      result.edges.some(
        (e) => e.kind === "implements" && e.from_symbol === "A" && e.to === "Disposable",
      ),
    ).toBe(true);
    // `mixin Disposable on Base` vira extends
    expect(
      result.edges.some(
        (e) => e.kind === "extends" && e.from_symbol === "Disposable" && e.to === "Base",
      ),
    ).toBe(true);
  });
});
