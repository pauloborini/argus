import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { extractFile } from "../src/extraction/extract-file.js";
import { extractDart } from "../src/extraction/extractors/dart.js";
import { extractGo } from "../src/extraction/extractors/go.js";
import { extractJava } from "../src/extraction/extractors/java.js";
import { extractPython } from "../src/extraction/extractors/python.js";
import { extractRust } from "../src/extraction/extractors/rust.js";
import { extractTypeScriptLike } from "../src/extraction/extractors/typescript.js";
import { initAllParsers, parseFile } from "../src/extraction/parsers/registry.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

describe("extractors core", () => {
  let tempDir: string | undefined;

  beforeAll(async () => {
    await initAllParsers();
  });

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it("resolve resolved_path em imports relativos TypeScript", () => {
    tempDir = mkdtempSync(join(tmpdir(), "cortex-import-resolve-"));
    writeFileSync(join(tempDir, "bar.ts"), "export const bar = 1;\n", "utf-8");
    writeFileSync(
      join(tempDir, "main.ts"),
      'import { bar } from "./bar";\nexport const main = bar;\n',
      "utf-8",
    );

    const result = extractFile(tempDir, "main.ts");
    expect(result.imports[0]?.source).toBe("./bar");
    expect(result.imports[0]?.resolved_path).toBe("bar.ts");
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

  it("TS: arrow-const vira function e call carrega from_symbol do escopo", () => {
    const src = "export const calc = (a) => { return helper(a); };\nfunction helper(x) { return x + 1; }\n";
    const { rootNode } = parseFile("typescript", src);
    const result = extractTypeScriptLike(rootNode);

    expect(result.symbols.find((s) => s.name === "calc")?.kind).toBe("function");
    const callEdge = result.edges.find((e) => e.kind === "calls" && e.to === "helper");
    expect(callEdge?.from_symbol).toBe("calc");
  });

  it("Python: extends só superclasses posicionais (sem metaclass) e from_symbol em call", () => {
    const src = "class A:\n    pass\n\nclass B(A, metaclass=Meta):\n    def run(self):\n        helper()\n";
    const { rootNode } = parseFile("python", src);
    const result = extractPython(rootNode);

    const extendsEdges = result.edges.filter((e) => e.kind === "extends");
    expect(extendsEdges.some((e) => e.to === "A")).toBe(true);
    expect(extendsEdges.some((e) => e.to === "Meta")).toBe(false);
    const call = result.edges.find((e) => e.kind === "calls" && e.to === "helper");
    expect(call?.from_symbol).toBe("run");
  });

  it("Go: interface_type vira kind interface", () => {
    const src = "package x\n\ntype Reader interface {\n\tRead() error\n}\n";
    const { rootNode } = parseFile("go", src);
    const result = extractGo(rootNode);

    expect(result.symbols.find((s) => s.name === "Reader")?.kind).toBe("interface");
  });

  it("Rust: impl Trait for Type gera edge implements", () => {
    const src = "trait T {}\nstruct S;\nimpl T for S {\n    fn run(&self) {}\n}\n";
    const { rootNode } = parseFile("rust", src);
    const result = extractRust(rootNode);

    expect(
      result.edges.some((e) => e.kind === "implements" && e.from_symbol === "S" && e.to === "T"),
    ).toBe(true);
  });

  it("Dart: símbolos usam o nome real (não o tipo de retorno) e geram call edges", () => {
    const src =
      "class Repo {\n  int load() { return helper(); }\n  void save() { db.write(1); }\n}\nint helper() => 1;\n";
    const { rootNode } = parseFile("dart", src);
    const result = extractDart(rootNode);

    expect(result.symbols.some((s) => s.name === "load" && s.kind === "function")).toBe(true);
    expect(result.symbols.some((s) => s.name === "helper")).toBe(true);
    expect(result.symbols.some((s) => s.name === "int")).toBe(false);
    const call = result.edges.find((e) => e.kind === "calls" && e.to === "helper");
    expect(call?.from_symbol).toBe("load");
    expect(
      result.edges.some((e) => e.kind === "calls" && e.to === "write" && e.from_symbol === "save"),
    ).toBe(true);
  });

  it("Go: struct e interface embedding geram edges extends", () => {
    const src =
      "package x\ntype Dog struct {\n  Animal\n  sync.Mutex\n  age int\n}\ntype Reader interface {\n  Readable\n  io.Reader\n  Read() error\n}\n";
    const { rootNode } = parseFile("go", src);
    const result = extractGo(rootNode);

    expect(result.edges.some((e) => e.kind === "extends" && e.from_symbol === "Dog" && e.to === "Animal")).toBe(true);
    expect(result.edges.some((e) => e.kind === "extends" && e.from_symbol === "Dog" && e.to === "Mutex")).toBe(true);
    expect(result.edges.some((e) => e.kind === "extends" && e.from_symbol === "Reader" && e.to === "Reader")).toBe(true);
    expect(result.edges.some((e) => e.kind === "extends" && e.from_symbol === "Reader" && e.to === "Readable")).toBe(true);
    expect(result.edges.some((e) => e.kind === "extends" && e.to === "int")).toBe(false);
  });

  it("Dart: import relativo resolve resolved_path", () => {
    tempDir = mkdtempSync(join(tmpdir(), "cortex-dart-import-"));
    writeFileSync(join(tempDir, "dep.dart"), "class Dep {}\n", "utf-8");
    writeFileSync(join(tempDir, "main.dart"), "import 'dep.dart';\n\nclass Main {}\n", "utf-8");

    const result = extractFile(tempDir, "main.dart");
    expect(result.imports.find((i) => i.source === "dep.dart")?.resolved_path).toBe("dep.dart");
    expect(result.imports.find((i) => i.source.startsWith("package:"))?.resolved_path).toBeUndefined();
  });
});
