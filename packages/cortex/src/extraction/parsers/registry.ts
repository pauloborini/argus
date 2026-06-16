import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import Parser from "tree-sitter";
import type { SyntaxNode } from "tree-sitter";
import Go from "tree-sitter-go";
import Java from "tree-sitter-java";
import Kotlin from "tree-sitter-kotlin";
import Python from "tree-sitter-python";
import Rust from "tree-sitter-rust";
import TypeScript from "tree-sitter-typescript";
import WebTreeSitter from "web-tree-sitter";
import type { SupportedLanguage } from "../types.js";

const require = createRequire(import.meta.url);
const dartWasmPath = require.resolve("tree-sitter-dart/tree-sitter-dart.wasm");

export interface ParseResult {
  rootNode: SyntaxNode;
}

const nativeParsers = new Map<SupportedLanguage, Parser>();

let dartParser: InstanceType<typeof WebTreeSitter> | null = null;
let dartInitPromise: Promise<void> | null = null;

function getNativeParser(language: SupportedLanguage): Parser {
  const existing = nativeParsers.get(language);
  if (existing) {
    return existing;
  }

  const parser = new Parser();
  switch (language) {
    case "typescript":
      parser.setLanguage(TypeScript.typescript);
      break;
    case "javascript": {
      const jsLanguage =
        "javascript" in TypeScript &&
        TypeScript.javascript !== undefined &&
        TypeScript.javascript !== null
          ? TypeScript.javascript
          : TypeScript.typescript;
      parser.setLanguage(jsLanguage);
      break;
    }
    case "python":
      parser.setLanguage(Python);
      break;
    case "go":
      parser.setLanguage(Go);
      break;
    case "java":
      parser.setLanguage(Java);
      break;
    case "rust":
      parser.setLanguage(Rust);
      break;
    case "kotlin":
      parser.setLanguage(Kotlin);
      break;
    default:
      throw new Error(`Linguagem sem parser nativo: ${language}`);
  }

  nativeParsers.set(language, parser);
  return parser;
}

export async function ensureDartParser(): Promise<void> {
  if (dartParser) {
    return;
  }

  if (!dartInitPromise) {
    dartInitPromise = (async () => {
      await WebTreeSitter.init();
      const wasm = readFileSync(dartWasmPath);
      const language = await WebTreeSitter.Language.load(wasm);
      const parser = new WebTreeSitter();
      parser.setLanguage(language);
      dartParser = parser;
    })();
  }

  await dartInitPromise;
}

export async function initAllParsers(): Promise<void> {
  await ensureDartParser();
}

export function parseFile(language: SupportedLanguage, source: string): ParseResult {
  if (language === "dart") {
    if (!dartParser) {
      throw new Error("Parser Dart não inicializado; chame initAllParsers() antes.");
    }
    const tree = dartParser.parse(source);
    return { rootNode: tree.rootNode as unknown as SyntaxNode };
  }

  const parser = getNativeParser(language);
  const tree = parser.parse(source);
  return { rootNode: tree.rootNode };
}
