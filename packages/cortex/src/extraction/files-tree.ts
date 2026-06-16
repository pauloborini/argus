import type { FileStructuralEntry } from "./types.js";

export interface FileTreeNode {
  path: string;
  symbol_counts?: {
    total: number;
    functions: number;
    classes: number;
    other: number;
  };
}

export function buildFilesTree(entries: FileStructuralEntry[]): FileTreeNode[] {
  return entries
    .filter((entry) => entry.language !== "unsupported")
    .sort((a, b) => a.relative_path.localeCompare(b.relative_path))
    .map((entry) => ({
      path: entry.relative_path,
      symbol_counts: summarizeSymbolCounts(entry),
    }));
}

function summarizeSymbolCounts(entry: FileStructuralEntry): FileTreeNode["symbol_counts"] {
  if (entry.parse_errors.length > 0) {
    return { total: 0, functions: 0, classes: 0, other: 0 };
  }

  let functions = 0;
  let classes = 0;
  let other = 0;

  for (const symbol of entry.symbols) {
    if (symbol.kind === "function") {
      functions += 1;
    } else if (symbol.kind === "class" || symbol.kind === "interface") {
      classes += 1;
    } else {
      other += 1;
    }
  }

  return {
    total: entry.symbols.length,
    functions,
    classes,
    other,
  };
}

export function collectIndexedLanguages(entries: FileStructuralEntry[]): string[] {
  const languages = new Set<string>();
  for (const entry of entries) {
    if (entry.language !== "unsupported") {
      languages.add(entry.language);
    }
  }
  return [...languages].sort();
}
