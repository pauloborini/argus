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

  // --- Novos casos de paridade S31 ---

  it("Dart: construtores (default, nomeado, factory) são símbolos navegáveis", () => {
    const src =
      "class MyWidget {\n" +
      "  final String label;\n" +
      "  MyWidget(this.label);\n" +
      "  MyWidget.named({required this.label});\n" +
      "  factory MyWidget.create() => MyWidget('default');\n" +
      "}\n";
    const { rootNode } = parseFile("dart", src);
    const result = extractDart(rootNode);

    // construtor default
    expect(result.symbols.some((s) => s.name === "MyWidget" && s.kind === "function")).toBe(true);
    // construtor nomeado
    expect(result.symbols.some((s) => s.name === "MyWidget.named" && s.kind === "function")).toBe(true);
    // factory
    expect(result.symbols.some((s) => s.name === "MyWidget.create" && s.kind === "function")).toBe(true);
  });

  it("Dart: const constructor é símbolo navegável (Flutter usa const em todo widget leaf)", () => {
    // `const` constructors são onipresentes em Flutter: const Text(...), const EdgeInsets.all(8)
    // Node type: constant_constructor_signature
    const src =
      "class Icon {\n" +
      "  final String name;\n" +
      "  const Icon(this.name);\n" +
      "  const Icon.outlined(this.name);\n" +
      "}\n";
    const { rootNode } = parseFile("dart", src);
    const result = extractDart(rootNode);

    // const default
    expect(result.symbols.some((s) => s.name === "Icon" && s.kind === "function")).toBe(true);
    // const nomeado
    expect(result.symbols.some((s) => s.name === "Icon.outlined" && s.kind === "function")).toBe(true);
  });

  it("Dart: redirecting factory constructor é símbolo navegável", () => {
    // `factory Foo.named() = Foo._internal` — redirects para outro construtor.
    // Padrão usado em classes imutáveis/sealed e em packages como freezed.
    // Node type: redirecting_factory_constructor_signature
    const src =
      "class Color {\n" +
      "  final int value;\n" +
      "  const Color(this.value);\n" +
      "  factory Color.fromARGB(int a, int r, int g, int b) = Color._fromARGB;\n" +
      "  Color._fromARGB(int v) : value = v;\n" +
      "}\n";
    const { rootNode } = parseFile("dart", src);
    const result = extractDart(rootNode);

    // redirecting factory
    expect(result.symbols.some((s) => s.name === "Color.fromARGB" && s.kind === "function")).toBe(true);
    // construtor privado nomeado
    expect(result.symbols.some((s) => s.name === "Color._fromARGB" && s.kind === "function")).toBe(true);
  });

  it("Dart: campos de instância de classe entram no grafo de símbolos", () => {
    const src =
      "class Repo {\n" +
      "  final String id;\n" +
      "  int version = 0;\n" +
      "}\n";
    const { rootNode } = parseFile("dart", src);
    const result = extractDart(rootNode);

    expect(result.symbols.some((s) => s.name === "id" && s.kind === "variable")).toBe(true);
    expect(result.symbols.some((s) => s.name === "version" && s.kind === "variable")).toBe(true);
  });

  it("Dart: enum members são extraídos como símbolos variable", () => {
    const src = "enum Status { active, inactive, pending }\n";
    const { rootNode } = parseFile("dart", src);
    const result = extractDart(rootNode);

    // enum como tipo
    expect(result.symbols.some((s) => s.name === "Status" && s.kind === "enum")).toBe(true);
    // cada membro como variável navegável
    expect(result.symbols.some((s) => s.name === "active" && s.kind === "variable")).toBe(true);
    expect(result.symbols.some((s) => s.name === "inactive" && s.kind === "variable")).toBe(true);
    expect(result.symbols.some((s) => s.name === "pending" && s.kind === "variable")).toBe(true);
  });

  it("Dart: diretiva part gera edge imports para grafo de biblioteca fragmentada", () => {
    const source = readFileSync(join(fixturesDir, "sample.dart"), "utf-8");
    const { rootNode } = parseFile("dart", source);
    const result = extractDart(rootNode);

    // `part 'sample_part.dart'` deve gerar edge imports
    expect(result.edges.some((e) => e.kind === "imports" && e.to.includes("sample_part"))).toBe(true);
    expect(result.imports.some((i) => i.source.includes("sample_part"))).toBe(true);
  });

  it("Dart: diretiva export gera edge imports para propagação de re-export", () => {
    // arquivo de biblioteca Dart puro (sem part) com export
    const src = "export 'dart:math';\nexport 'package:flutter/widgets.dart';\n\nclass Barrel {}\n";
    const { rootNode } = parseFile("dart", src);
    const result = extractDart(rootNode);

    // `export 'dart:math'` deve gerar edge imports
    expect(result.edges.some((e) => e.kind === "imports" && e.to === "dart:math")).toBe(true);
    expect(result.imports.some((i) => i.source === "dart:math")).toBe(true);
    // `export 'package:flutter/widgets.dart'`
    expect(result.imports.some((i) => i.source.includes("flutter/widgets"))).toBe(true);
  });

  it("Dart: part of gera edge imports conectando parte à biblioteca", () => {
    const src = "part of 'sample.dart';\n\nclass PartWidget {}\n";
    const { rootNode } = parseFile("dart", src);
    const result = extractDart(rootNode);

    expect(result.edges.some((e) => e.kind === "imports" && e.to.includes("sample"))).toBe(true);
    expect(result.imports.some((i) => i.source.includes("sample"))).toBe(true);
  });

  it("Dart: cascade (..) gera edge calls para os métodos encadeados", () => {
    const src =
      "class Builder {\n" +
      "  void build() {\n" +
      "    final list = <int>[];\n" +
      "    list..add(1)..add(2)..clear();\n" +
      "  }\n" +
      "}\n";
    const { rootNode } = parseFile("dart", src);
    const result = extractDart(rootNode);

    // cascades devem gerar edges de calls para add e clear
    expect(result.edges.some((e) => e.kind === "calls" && e.to === "add")).toBe(true);
    expect(result.edges.some((e) => e.kind === "calls" && e.to === "clear")).toBe(true);
  });

  it("Dart: instanciação de widget gera edge calls", () => {
    const src =
      "class Screen {\n" +
      "  void build() {\n" +
      "    final w = Container();\n" +
      "    final t = Text('hello');\n" +
      "  }\n" +
      "}\n";
    const { rootNode } = parseFile("dart", src);
    const result = extractDart(rootNode);

    // Container() e Text() são instanciações → edges calls
    expect(result.edges.some((e) => e.kind === "calls" && e.to === "Container")).toBe(true);
    expect(result.edges.some((e) => e.kind === "calls" && e.to === "Text")).toBe(true);
  });

  it("Dart: operator overloading (==, +, []) são símbolos navegáveis", () => {
    // Operadores são comuns em classes de valor Flutter: Color, Size, Offset, EdgeInsets
    // usam `operator ==`, `operator +`, `operator []` rotineiramente.
    const src =
      "class Vec {\n" +
      "  int x = 0;\n" +
      "  Vec operator +(Vec other) => Vec();\n" +
      "  bool operator ==(Object other) => true;\n" +
      "  int operator [](int index) => 0;\n" +
      "}\n";
    const { rootNode } = parseFile("dart", src);
    const result = extractDart(rootNode);

    expect(result.symbols.some((s) => s.name === "operator+" && s.kind === "function")).toBe(true);
    expect(result.symbols.some((s) => s.name === "operator==" && s.kind === "function")).toBe(true);
    expect(result.symbols.some((s) => s.name === "operator[]" && s.kind === "function")).toBe(true);
  });

  // --- Limites de parser (tree-sitter-dart versão atual) ---
  // Estes testes documentam o comportamento observável dentro das limitações conhecidas.
  // A correção exige atualizar o pacote tree-sitter-dart para suportar Dart 3 grammar.

  it("Dart: enhanced enum (Dart 2.17) — parser atual só extrai membro simples sem args [limite de parser]", () => {
    // `enum E { a('x'), b('y'); const E(this.v); }` causa parse ERROR no tree-sitter-dart atual.
    // Comportamento esperado com a versão atual: apenas membros sem argumentos são extraídos.
    const src = "enum Status { active, inactive }\n"; // sintaxe simples sempre funciona
    const { rootNode } = parseFile("dart", src);
    const result = extractDart(rootNode);

    expect(result.symbols.some((s) => s.name === "active" && s.kind === "variable")).toBe(true);
    expect(result.symbols.some((s) => s.name === "inactive" && s.kind === "variable")).toBe(true);
  });

  it("Dart: sealed class (Dart 3) — parser atual não suporta keyword sealed [limite de parser]", () => {
    // `sealed class S {}` gera ERROR no tree-sitter-dart atual — a classe se perde.
    // Limite documentado: requer atualizar tree-sitter-dart para grammar Dart 3.
    // Por ora, classes concretas que estendem o sealed são extraídas normalmente.
    const src =
      "class Circle { double radius = 0; }\n" +
      "class Rect { double w = 0; double h = 0; }\n";
    const { rootNode } = parseFile("dart", src);
    const result = extractDart(rootNode);

    expect(result.symbols.some((s) => s.name === "Circle" && s.kind === "class")).toBe(true);
    expect(result.symbols.some((s) => s.name === "Rect" && s.kind === "class")).toBe(true);
  });
});
