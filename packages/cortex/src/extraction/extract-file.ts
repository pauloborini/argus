import { existsSync, readFileSync } from "node:fs";
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

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return relative(rootPath, candidate);
    }
  }

  return undefined;
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
    const imports =
      detection.language === "typescript" || detection.language === "javascript"
        ? resolveTypeScriptImports(rootPath, relativePath, result.imports)
        : result.imports;
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
