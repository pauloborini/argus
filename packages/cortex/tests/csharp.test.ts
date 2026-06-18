import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extractCSharp } from "../src/extraction/extractors/csharp.js";
import { parseFile } from "../src/extraction/parsers/registry.js";
import { detectLanguageFromPath, SUPPORTED_LANGUAGES } from "../src/extraction/language.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

describe("C# extractor", () => {
  it("detectLanguageFromPath para .cs e .csx retorna csharp/full", () => {
    expect(detectLanguageFromPath("src/Foo.cs")).toEqual({
      status: "supported",
      language: "csharp",
      coverage_level: "full",
    });
    expect(detectLanguageFromPath("scripts/run.csx")).toEqual({
      status: "supported",
      language: "csharp",
      coverage_level: "full",
    });
  });

  it("SUPPORTED_LANGUAGES inclui csharp (9 linguagens)", () => {
    expect(SUPPORTED_LANGUAGES).toContain("csharp");
    expect(SUPPORTED_LANGUAGES.length).toBe(9);
  });

  it("extrai namespace (block-scoped)", () => {
    const source = readFileSync(join(fixturesDir, "sample.cs"), "utf-8");
    const { rootNode } = parseFile("csharp", source);
    const result = extractCSharp(rootNode);

    expect(result.symbols.some((s) => s.name === "MyApp.Models" && s.kind === "module")).toBe(true);
  });

  it("extrai namespace (file-scoped)", () => {
    const source = readFileSync(join(fixturesDir, "sample_part1.cs"), "utf-8");
    const { rootNode } = parseFile("csharp", source);
    const result = extractCSharp(rootNode);

    expect(result.symbols.some((s) => s.name === "MyApp.Models" && s.kind === "module")).toBe(true);
  });

  it("extrai class, struct, record e record struct como kind class", () => {
    const source = readFileSync(join(fixturesDir, "sample.cs"), "utf-8");
    const { rootNode } = parseFile("csharp", source);
    const result = extractCSharp(rootNode);

    expect(result.symbols.some((s) => s.name === "Person" && s.kind === "class")).toBe(true);
    expect(result.symbols.some((s) => s.name === "Point" && s.kind === "class")).toBe(true);
    expect(result.symbols.some((s) => s.name === "Order" && s.kind === "class")).toBe(true);
    expect(result.symbols.some((s) => s.name === "Measurement" && s.kind === "class")).toBe(true);
  });

  it("extrai interface e enum corretamente", () => {
    const source = readFileSync(join(fixturesDir, "sample.cs"), "utf-8");
    const { rootNode } = parseFile("csharp", source);
    const result = extractCSharp(rootNode);

    expect(result.symbols.some((s) => s.name === "IRepo" && s.kind === "interface")).toBe(true);
    expect(result.symbols.some((s) => s.name === "Status" && s.kind === "enum")).toBe(true);
    expect(result.symbols.some((s) => s.name === "Active" && s.kind === "variable")).toBe(true);
    expect(result.symbols.some((s) => s.name === "Inactive" && s.kind === "variable")).toBe(true);
  });

  it("extrai delegate como kind type", () => {
    const source = readFileSync(join(fixturesDir, "sample.cs"), "utf-8");
    const { rootNode } = parseFile("csharp", source);
    const result = extractCSharp(rootNode);

    expect(result.symbols.some((s) => s.name === "Handler" && s.kind === "type")).toBe(true);
  });

  it("extrai construtor, método, property, campo e evento", () => {
    const source = readFileSync(join(fixturesDir, "sample.cs"), "utf-8");
    const { rootNode } = parseFile("csharp", source);
    const result = extractCSharp(rootNode);

    // Constructor emits class name as function
    expect(result.symbols.some((s) => s.name === "Person" && s.kind === "function")).toBe(true);
    expect(result.symbols.some((s) => s.name === "Greet" && s.kind === "function")).toBe(true);
    expect(result.symbols.some((s) => s.name === "Name" && s.kind === "variable")).toBe(true);
    expect(result.symbols.some((s) => s.name === "_age" && s.kind === "variable")).toBe(true);
    expect(result.symbols.some((s) => s.name === "Changed" && s.kind === "variable")).toBe(true);
  });

  it("base list: classe extends + implements", () => {
    const source = readFileSync(join(fixturesDir, "sample.cs"), "utf-8");
    const { rootNode } = parseFile("csharp", source);
    const result = extractCSharp(rootNode);

    expect(
      result.edges.some((e) => e.kind === "extends" && e.from_symbol === "Person" && e.to === "BaseEntity"),
    ).toBe(true);
    expect(
      result.edges.some((e) => e.kind === "implements" && e.from_symbol === "Person" && e.to === "ISerializable"),
    ).toBe(true);
  });

  it("base list: interface implements", () => {
    const source = readFileSync(join(fixturesDir, "sample.cs"), "utf-8");
    const { rootNode } = parseFile("csharp", source);
    const result = extractCSharp(rootNode);

    expect(
      result.edges.some((e) => e.kind === "implements" && e.from_symbol === "IRepo" && e.to === "IDisposable"),
    ).toBe(true);
  });

  it("base list: record struct sempre implements (sem extends)", () => {
    const source = readFileSync(join(fixturesDir, "sample.cs"), "utf-8");
    const { rootNode } = parseFile("csharp", source);
    const result = extractCSharp(rootNode);

    expect(
      result.edges.some((e) => e.kind === "implements" && e.from_symbol === "Measurement" && e.to === "IComparable"),
    ).toBe(true);
    expect(
      result.edges.some((e) => e.kind === "extends" && e.from_symbol === "Measurement"),
    ).toBe(false);
  });

  it("new T() e invocation geram edges calls com from_symbol", () => {
    const source = readFileSync(join(fixturesDir, "sample.cs"), "utf-8");
    const { rootNode } = parseFile("csharp", source);
    const result = extractCSharp(rootNode);

    expect(
      result.edges.some((e) => e.kind === "calls" && e.from_symbol === "Greet" && e.to === "Console.WriteLine"),
    ).toBe(true);
    expect(
      result.edges.some((e) => e.kind === "calls" && e.from_symbol === "Greet" && e.to === "List"),
    ).toBe(true);
  });

  it("using, using static, global using e alias geram imports + edges", () => {
    const source = readFileSync(join(fixturesDir, "sample.cs"), "utf-8");
    const { rootNode } = parseFile("csharp", source);
    const result = extractCSharp(rootNode);

    expect(result.imports.some((i) => i.source === "System")).toBe(true);
    expect(result.imports.some((i) => i.source === "System.Math")).toBe(true);
    expect(result.imports.some((i) => i.source === "System.Collections.Generic")).toBe(true);
    expect(
      result.imports.some((i) => i.source === "System.Text.StringBuilder" && i.symbols?.includes("Alias")),
    ).toBe(true);

    expect(result.edges.filter((e) => e.kind === "imports").length).toBeGreaterThanOrEqual(4);
  });

  it("partial class em 2 arquivos: ambos emitem Foo", () => {
    const src1 = readFileSync(join(fixturesDir, "sample_part1.cs"), "utf-8");
    const src2 = readFileSync(join(fixturesDir, "sample_part2.cs"), "utf-8");
    const r1 = extractCSharp(parseFile("csharp", src1).rootNode);
    const r2 = extractCSharp(parseFile("csharp", src2).rootNode);

    expect(r1.symbols.some((s) => s.name === "Foo" && s.kind === "class")).toBe(true);
    expect(r2.symbols.some((s) => s.name === "Foo" && s.kind === "class")).toBe(true);
    expect(r1.symbols.some((s) => s.name === "MethodA" && s.kind === "function")).toBe(true);
    expect(r2.symbols.some((s) => s.name === "MethodB" && s.kind === "function")).toBe(true);
  });

  it("tipo aninhado: membro não duplicado", () => {
    const source = readFileSync(join(fixturesDir, "sample.cs"), "utf-8");
    const { rootNode } = parseFile("csharp", source);
    const result = extractCSharp(rootNode);

    // InnerMethod belongs to Inner, not duplicated as Person member
    const innerMethods = result.symbols.filter((s) => s.name === "InnerMethod");
    expect(innerMethods.length).toBe(1);

    // Inner class exists as its own symbol
    expect(result.symbols.some((s) => s.name === "Inner" && s.kind === "class")).toBe(true);
  });
});
