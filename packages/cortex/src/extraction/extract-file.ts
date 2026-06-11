import { readFileSync } from "node:fs";
import { join } from "node:path";
import { detectLanguageFromPath } from "./language.js";
import { extractDart } from "./extractors/dart.js";
import { extractGo } from "./extractors/go.js";
import { extractJava } from "./extractors/java.js";
import { extractKotlin } from "./extractors/kotlin.js";
import { extractPython } from "./extractors/python.js";
import { extractRust } from "./extractors/rust.js";
import { extractTypeScriptLike } from "./extractors/typescript.js";
import { parseFile } from "./parsers/registry.js";
import type { FileExtractionResult, FileStructuralEntry, SupportedLanguage } from "./types.js";

function dispatchExtractor(language: SupportedLanguage, source: string): FileExtractionResult {
  const { rootNode } = parseFile(language, source);

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
    return {
      relative_path: relativePath,
      language: detection.language,
      ...result,
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
