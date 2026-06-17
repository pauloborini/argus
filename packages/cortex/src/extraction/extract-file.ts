import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import { detectLanguageFromPath } from "./language.js";
import { extractDart } from "./extractors/dart.js";
import { extractGo } from "./extractors/go.js";
import { extractJava } from "./extractors/java.js";
import { extractKotlin } from "./extractors/kotlin.js";
import { extractPython } from "./extractors/python.js";
import { extractRust } from "./extractors/rust.js";
import { extractTypeScriptLike } from "./extractors/typescript.js";
import { parseFile } from "./parsers/registry.js";
import type { SyntaxNode } from "tree-sitter";
import type {
  ExtractedImport,
  FileExtractionResult,
  FileStructuralEntry,
  SupportedLanguage,
} from "./types.js";

const TS_IMPORT_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"];

function toRelativePath(rootPath: string, absolutePath: string): string {
  return relative(rootPath, absolutePath).split("\\").join("/");
}

function firstExistingPath(rootPath: string, candidates: string[]): string | undefined {
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return toRelativePath(rootPath, candidate);
    }
  }
  return undefined;
}

function singleFileInDir(rootPath: string, dirPath: string, extensions: string[]): string | undefined {
  if (!existsSync(dirPath)) {
    return undefined;
  }
  try {
    const files = readdirSync(dirPath)
      .filter((item) => extensions.some((ext) => item.endsWith(ext)))
      .sort((a, b) => a.localeCompare(b));
    return files.length === 1 ? toRelativePath(rootPath, join(dirPath, files[0]!)) : undefined;
  } catch {
    return undefined;
  }
}

function resolveTypeScriptImportPath(
  rootPath: string,
  fromRelativePath: string,
  importSource: string,
): string | undefined {
  if (!importSource.startsWith(".")) {
    return undefined;
  }

  const base = normalize(join(dirname(join(rootPath, fromRelativePath)), importSource));
  const candidates = [
    base,
    ...TS_IMPORT_EXTENSIONS.map((ext) => `${base}${ext}`),
    ...TS_IMPORT_EXTENSIONS.map((ext) => join(base, `index${ext}`)),
  ];

  return firstExistingPath(rootPath, candidates);
}

function resolveTypeScriptImports(
  rootPath: string,
  fromRelativePath: string,
  imports: ExtractedImport[],
): ExtractedImport[] {
  return imports.map((entry) => {
    const resolved_path = resolveTypeScriptImportPath(rootPath, fromRelativePath, entry.source);
    return resolved_path ? { ...entry, resolved_path } : entry;
  });
}

function resolvePythonImportPath(
  rootPath: string,
  fromRelativePath: string,
  importSource: string,
): string | undefined {
  const modulePath = importSource.replace(/^\.+/, "").replace(/\./g, "/");
  if (!modulePath) {
    return undefined;
  }
  const fromDir = dirname(join(rootPath, fromRelativePath));
  const candidates = [
    join(fromDir, `${modulePath}.py`),
    join(fromDir, modulePath, "__init__.py"),
    join(rootPath, `${modulePath}.py`),
    join(rootPath, modulePath, "__init__.py"),
  ];
  return firstExistingPath(rootPath, candidates);
}

function resolvePythonImports(
  rootPath: string,
  fromRelativePath: string,
  imports: ExtractedImport[],
): ExtractedImport[] {
  return imports.map((entry) => {
    const resolved_path = resolvePythonImportPath(rootPath, fromRelativePath, entry.source);
    return resolved_path ? { ...entry, resolved_path } : entry;
  });
}

function resolveGoImportPath(
  rootPath: string,
  fromRelativePath: string,
  importSource: string,
): string | undefined {
  const baseDir = importSource.startsWith(".")
    ? normalize(join(dirname(join(rootPath, fromRelativePath)), importSource))
    : normalize(join(rootPath, importSource));
  return (
    firstExistingPath(rootPath, [`${baseDir}.go`]) ??
    singleFileInDir(rootPath, baseDir, [".go"])
  );
}

function resolveGoImports(
  rootPath: string,
  fromRelativePath: string,
  imports: ExtractedImport[],
): ExtractedImport[] {
  return imports.map((entry) => {
    const resolved_path = resolveGoImportPath(rootPath, fromRelativePath, entry.source);
    return resolved_path ? { ...entry, resolved_path } : entry;
  });
}

function resolveDottedImportPath(
  rootPath: string,
  fromRelativePath: string,
  importSource: string,
  extension: ".java" | ".kt",
): string | undefined {
  const sourcePath = importSource.replace(/\./g, "/");
  const fromDir = dirname(join(rootPath, fromRelativePath));
  const candidates = [
    join(fromDir, `${sourcePath}${extension}`),
    join(rootPath, `${sourcePath}${extension}`),
  ];
  return firstExistingPath(rootPath, candidates);
}

function resolveDottedImports(
  rootPath: string,
  fromRelativePath: string,
  imports: ExtractedImport[],
  extension: ".java" | ".kt",
): ExtractedImport[] {
  return imports.map((entry) => {
    const resolved_path = resolveDottedImportPath(rootPath, fromRelativePath, entry.source, extension);
    return resolved_path ? { ...entry, resolved_path } : entry;
  });
}

function resolveRustImportPath(
  rootPath: string,
  fromRelativePath: string,
  importSource: string,
): string | undefined {
  if (importSource.startsWith("std::") || importSource.startsWith("core::") || importSource.startsWith("alloc::")) {
    return undefined;
  }
  const fromDir = dirname(join(rootPath, fromRelativePath));
  const stripped = importSource
    .replace(/^crate::/, "")
    .replace(/^self::/, "")
    .replace(/^super::/, "../");
  const modulePath = stripped.replace(/::/g, "/");
  if (!modulePath) {
    return undefined;
  }
  const base = importSource.startsWith("crate::") ? rootPath : fromDir;
  const target = normalize(join(base, modulePath));
  const rootTarget = normalize(join(rootPath, modulePath));
  return firstExistingPath(rootPath, [
    `${target}.rs`,
    join(target, "mod.rs"),
    `${rootTarget}.rs`,
    join(rootTarget, "mod.rs"),
  ]);
}

function resolveRustImports(
  rootPath: string,
  fromRelativePath: string,
  imports: ExtractedImport[],
): ExtractedImport[] {
  return imports.map((entry) => {
    const resolved_path = resolveRustImportPath(rootPath, fromRelativePath, entry.source);
    return resolved_path ? { ...entry, resolved_path } : entry;
  });
}

function resolveImportsForLanguage(
  language: SupportedLanguage,
  rootPath: string,
  relativePath: string,
  imports: ExtractedImport[],
): ExtractedImport[] {
  switch (language) {
    case "typescript":
    case "javascript":
      return resolveTypeScriptImports(rootPath, relativePath, imports);
    case "python":
      return resolvePythonImports(rootPath, relativePath, imports);
    case "go":
      return resolveGoImports(rootPath, relativePath, imports);
    case "java":
      return resolveDottedImports(rootPath, relativePath, imports, ".java");
    case "kotlin":
      return resolveDottedImports(rootPath, relativePath, imports, ".kt");
    case "rust":
      return resolveRustImports(rootPath, relativePath, imports);
    case "dart":
      return resolveDartImports(rootPath, relativePath, imports);
  }
}

/**
 * Resolve imports **relativos** de Dart (`import 'widgets/foo.dart'`). URIs
 * `package:`/`dart:` não mapeiam para arquivo do workspace e ficam undefined.
 * O source já traz a extensão `.dart`, então não há adivinhação de extensão.
 */
function resolveDartImportPath(
  rootPath: string,
  fromRelativePath: string,
  importSource: string,
): string | undefined {
  if (importSource.startsWith("package:") || importSource.startsWith("dart:")) {
    return undefined;
  }
  const candidate = normalize(join(dirname(join(rootPath, fromRelativePath)), importSource));
  return existsSync(candidate) ? toRelativePath(rootPath, candidate) : undefined;
}

function resolveDartImports(
  rootPath: string,
  fromRelativePath: string,
  imports: ExtractedImport[],
): ExtractedImport[] {
  return imports.map((entry) => {
    const resolved_path = resolveDartImportPath(rootPath, fromRelativePath, entry.source);
    return resolved_path ? { ...entry, resolved_path } : entry;
  });
}

function extractBySupportedLanguage(
  language: SupportedLanguage,
  rootNode: SyntaxNode,
): FileExtractionResult {
  switch (language) {
    case "typescript":
    case "javascript":
      return extractTypeScriptLike(rootNode);
    case "python":
      return extractPython(rootNode);
    case "go":
      return extractGo(rootNode);
    case "java":
      return extractJava(rootNode);
    case "rust":
      return extractRust(rootNode);
    case "kotlin":
      return extractKotlin(rootNode);
    case "dart":
      return extractDart(rootNode);
    default:
      return { symbols: [], imports: [], edges: [], parse_errors: [] };
  }
}

/**
 * Localiza a linha (1-based) do primeiro nó `ERROR`/`MISSING` da árvore. Só é
 * chamada quando `rootNode.hasError` é verdadeiro; podando a descida pelos
 * próprios flags `hasError` dos filhos, o custo é O(profundidade), não O(nós).
 */
function findFirstSyntaxErrorLine(rootNode: SyntaxNode): number | undefined {
  const stack: SyntaxNode[] = [rootNode];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) {
      continue;
    }
    if (node.isError || node.isMissing) {
      return node.startPosition.row + 1;
    }
    for (const child of node.children) {
      if (child.hasError || child.isMissing) {
        stack.push(child);
      }
    }
  }
  return undefined;
}

function dispatchExtractor(language: SupportedLanguage, source: string): FileExtractionResult {
  const { rootNode } = parseFile(language, source);
  const result = extractBySupportedLanguage(language, rootNode);

  // Tree-sitter é error-recovering: em sintaxe inválida não lança — devolve uma
  // árvore com nós `ERROR`/`MISSING` e símbolos parciais. Sem inspecionar
  // `hasError`, o arquivo contaria como `files_parsed` com cobertura inflada e a
  // maquinaria de coverage/limitations ficaria como código morto. Registra o
  // erro para que a cobertura caia e a limitação seja honesta.
  if (rootNode.hasError) {
    const line = findFirstSyntaxErrorLine(rootNode);
    result.parse_errors = [
      ...result.parse_errors,
      {
        message:
          "E_PARSE_ERROR: árvore de sintaxe contém nós ERROR/MISSING; símbolos podem estar incompletos",
        ...(line !== undefined ? { line } : {}),
      },
    ];
  }

  return result;
}

export function extractFile(rootPath: string, relativePath: string): FileStructuralEntry {
  const detection = detectLanguageFromPath(relativePath);
  if (detection.status === "unsupported") {
    return {
      relative_path: relativePath,
      language: "unsupported",
      symbols: [],
      imports: [],
      edges: [],
      parse_errors: [],
    };
  }

  const absolutePath = join(rootPath, relativePath);

  try {
    const source = readFileSync(absolutePath, "utf-8");
    const result = dispatchExtractor(detection.language, source);
    const imports = resolveImportsForLanguage(
      detection.language,
      rootPath,
      relativePath,
      result.imports,
    );
    return {
      relative_path: relativePath,
      language: detection.language,
      ...result,
      imports,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      relative_path: relativePath,
      language: detection.language,
      symbols: [],
      imports: [],
      edges: [],
      parse_errors: [{ message: `Falha ao ler ou parsear arquivo: ${message}` }],
    };
  }
}
