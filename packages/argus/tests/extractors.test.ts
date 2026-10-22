import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { extractFile } from "../src/extraction/extract-file.js";
import { extractDart } from "../src/extraction/extractors/dart.js";
import { extractGo } from "../src/extraction/extractors/go.js";
import { extractJava } from "../src/extraction/extractors/java.js";
import { extractKotlin } from "../src/extraction/extractors/kotlin.js";
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
    tempDir = mkdtempSync(join(tmpdir(), "argus-import-resolve-"));
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

  it("resolve imports por alias de tsconfig e preserva imports relativos (§7.1)", () => {
    const fixtureRoot = join(fixturesDir, "sample-alias");
    const result = extractFile(fixtureRoot, "src/consumer.ts");
    const aliasImport = result.imports.find((i) => i.source === "@app/util");
    const relativeImport = result.imports.find((i) => i.source === "./util");

    expect(aliasImport).toBeDefined();
    expect(aliasImport?.resolved_path).toBe("src/util.ts");
    expect(relativeImport).toBeDefined();
    expect(relativeImport?.resolved_path).toBe("src/util.ts");
  });

  it("alias cujo target sai do rootPath não gera edge e mantém confinamento (§7.2)", () => {
    tempDir = mkdtempSync(join(tmpdir(), "argus-alias-escape-"));
    const outsideDir = mkdtempSync(join(tmpdir(), "argus-alias-outside-"));
    try {
      writeFileSync(join(outsideDir, "secret.ts"), "export const secret = 1;\n", "utf-8");
      const relToOutside = relative(tempDir, outsideDir).split("\\").join("/");
      writeFileSync(
        join(tempDir, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            baseUrl: ".",
            paths: {
              "@outside/*": [`${relToOutside}/*`],
            },
          },
        }),
        "utf-8",
      );
      writeFileSync(
        join(tempDir, "main.ts"),
        'import { secret } from "@outside/secret";\n',
        "utf-8",
      );

      const result = extractFile(tempDir, "main.ts");
      expect(result.imports[0]?.source).toBe("@outside/secret");
      expect(result.imports[0]?.resolved_path).toBeUndefined();
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("tsconfig com extends de 1 nível herda paths e 2 níveis degrada para undefined sem erro (§7.3)", () => {
    tempDir = mkdtempSync(join(tmpdir(), "argus-alias-extends-"));
    mkdirSync(join(tempDir, "shared"), { recursive: true });
    writeFileSync(join(tempDir, "shared", "helper.ts"), "export const val = 42;\n", "utf-8");

    // 1 nível: herda paths
    writeFileSync(
      join(tempDir, "tsconfig.base.json"),
      JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          paths: {
            "@shared/*": ["shared/*"],
          },
        },
      }),
      "utf-8",
    );
    writeFileSync(
      join(tempDir, "tsconfig.json"),
      JSON.stringify({
        extends: "./tsconfig.base.json",
      }),
      "utf-8",
    );
    writeFileSync(
      join(tempDir, "index.ts"),
      'import { val } from "@shared/helper";\n',
      "utf-8",
    );

    const result1 = extractFile(tempDir, "index.ts");
    expect(result1.imports[0]?.source).toBe("@shared/helper");
    expect(result1.imports[0]?.resolved_path).toBe("shared/helper.ts");

    // 2 níveis de extends: degrada para undefined sem erro
    writeFileSync(
      join(tempDir, "tsconfig.root.json"),
      JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          paths: {
            "@deep/*": ["shared/*"],
          },
        },
      }),
      "utf-8",
    );
    writeFileSync(
      join(tempDir, "tsconfig.mid.json"),
      JSON.stringify({
        extends: "./tsconfig.root.json",
      }),
      "utf-8",
    );
    writeFileSync(
      join(tempDir, "tsconfig.json"),
      JSON.stringify({
        extends: "./tsconfig.mid.json",
      }),
      "utf-8",
    );
    writeFileSync(
      join(tempDir, "deep.ts"),
      'import { val } from "@deep/helper";\n',
      "utf-8",
    );

    const result2 = extractFile(tempDir, "deep.ts");
    expect(result2.imports[0]?.source).toBe("@deep/helper");
    expect(result2.imports[0]?.resolved_path).toBeUndefined();
    expect(result2.parse_errors).toEqual([]);
  });

  it("sem tsconfig ou sem paths, import não-relativo devolve undefined (§7.4)", () => {
    tempDir = mkdtempSync(join(tmpdir(), "argus-alias-none-"));
    writeFileSync(
      join(tempDir, "main.ts"),
      'import { something } from "unmapped-pkg";\n',
      "utf-8",
    );

    const result = extractFile(tempDir, "main.ts");
    expect(result.imports[0]?.source).toBe("unmapped-pkg");
    expect(result.imports[0]?.resolved_path).toBeUndefined();
  });

  it("suporta tsconfig com comentários e trailing commas (JSONC)", () => {
    tempDir = mkdtempSync(join(tmpdir(), "argus-alias-jsonc-"));
    mkdirSync(join(tempDir, "lib"), { recursive: true });
    writeFileSync(join(tempDir, "lib", "tool.ts"), "export const ok = true;\n", "utf-8");
    writeFileSync(
      join(tempDir, "tsconfig.json"),
      `// Comentário de cabeçalho
{
  /* Bloco de comentário
     com múltiplas linhas */
  "compilerOptions": {
    "baseUrl": ".", // baseUrl aqui
    "paths": {
      "@lib/*": ["lib/*"], // trailing comma
    },
  },
}
`,
      "utf-8",
    );
    writeFileSync(
      join(tempDir, "main.ts"),
      'import { ok } from "@lib/tool";\n',
      "utf-8",
    );

    const result = extractFile(tempDir, "main.ts");
    expect(result.imports[0]?.resolved_path).toBe("lib/tool.ts");
  });


  it("resolve imports locais por linguagem quando há arquivo inequívoco", () => {
    tempDir = mkdtempSync(join(tmpdir(), "argus-import-resolve-poly-"));
    writeFileSync(join(tempDir, "dep.py"), "def helper(): pass\n", "utf-8");
    writeFileSync(join(tempDir, "main.py"), "from dep import helper\n", "utf-8");
    writeFileSync(join(tempDir, "dep.go"), "package main\n", "utf-8");
    writeFileSync(join(tempDir, "main.go"), 'package main\nimport "./dep"\n', "utf-8");
    mkdirSync(join(tempDir, "com", "acme"), { recursive: true });
    writeFileSync(join(tempDir, "com", "acme", "Dep.java"), "package com.acme; class Dep {}\n", "utf-8");
    writeFileSync(join(tempDir, "Main.java"), "import com.acme.Dep; class Main {}\n", "utf-8");
    writeFileSync(join(tempDir, "com", "acme", "Dep.kt"), "package com.acme\nclass Dep\n", "utf-8");
    writeFileSync(join(tempDir, "Main.kt"), "import com.acme.Dep\nclass Main\n", "utf-8");
    writeFileSync(join(tempDir, "dep.rs"), "pub fn helper() {}\n", "utf-8");
    writeFileSync(join(tempDir, "main.rs"), "use crate::dep;\n", "utf-8");

    expect(extractFile(tempDir, "main.py").imports[0]?.resolved_path).toBe("dep.py");
    expect(extractFile(tempDir, "main.go").imports[0]?.resolved_path).toBe("dep.go");
    expect(extractFile(tempDir, "Main.java").imports[0]?.resolved_path).toBe("com/acme/Dep.java");
    expect(extractFile(tempDir, "Main.kt").imports[0]?.resolved_path).toBe("com/acme/Dep.kt");
    expect(extractFile(tempDir, "main.rs").imports[0]?.resolved_path).toBe("dep.rs");
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
      result.edges.some((e) => e.kind === "calls" && e.to === "db.write" && e.from_symbol === "save"),
    ).toBe(true);
  });

  it("Java/Dart/Kotlin preservam receiver no callee raw", () => {
    const java = parseFile("java", "class A { void save() { db.write(1); helper(); } }\n");
    const dart = parseFile("dart", "class A { void save() { db.write(1); helper(); } }\n");
    const kotlin = parseFile("kotlin", "fun save() { db.write(1); helper() }\n");

    expect(extractJava(java.rootNode).edges.some((e) => e.kind === "calls" && e.to === "db.write")).toBe(true);
    expect(extractDart(dart.rootNode).edges.some((e) => e.kind === "calls" && e.to === "db.write")).toBe(true);
    expect(extractKotlin(kotlin.rootNode).edges.some((e) => e.kind === "calls" && e.to === "db.write")).toBe(true);
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
    tempDir = mkdtempSync(join(tmpdir(), "argus-dart-import-"));
    writeFileSync(join(tempDir, "dep.dart"), "class Dep {}\n", "utf-8");
    writeFileSync(join(tempDir, "main.dart"), "import 'dep.dart';\n\nclass Main {}\n", "utf-8");

    const result = extractFile(tempDir, "main.dart");
    expect(result.imports.find((i) => i.source === "dep.dart")?.resolved_path).toBe("dep.dart");
    expect(result.imports.find((i) => i.source.startsWith("package:"))?.resolved_path).toBeUndefined();
  });
});
