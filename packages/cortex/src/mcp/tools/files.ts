// Tool `files`: árvore estrutural do workspace + filtros.
import { stubResponse } from "../../contracts/response-state.js";
import type { FileTreeNode } from "../../extraction/files-tree.js";
import { closeIndexDb, openIndexDb, readFileTreeRows } from "../../storage/sqlite-index-store.js";
import type { FileTreeRow } from "../../storage/sqlite-index-store.js";
import { getIndexDbPath, readWorkspaceMetadata } from "../../workspace/workspace.js";
import { WORKSPACE_MISSING, mergeStructuralLimitations } from "./common.js";
import type { ToolResponsePayload, FilesArgs, IndexEnvelope } from "./common.js";

/** Tree + languages a partir de linhas agregadas em SQL (sem materializar o grafo). */
function fileTreeFromRows(rows: FileTreeRow[]): { tree: FileTreeNode[]; languages: string[] } {
  const languages = new Set<string>();
  const tree: FileTreeNode[] = [];
  for (const row of rows) {
    if (row.language === "unsupported") {
      continue;
    }
    languages.add(row.language);
    // Arquivo com erro de parse não tem contagem confiável: zera (mesma
    // semântica de summarizeSymbolCounts).
    const counts = row.has_parse_errors
      ? { total: 0, functions: 0, classes: 0, other: 0 }
      : { total: row.total, functions: row.functions, classes: row.classes, other: row.other };
    tree.push({ path: row.relative_path, symbol_counts: counts });
  }
  return { tree, languages: [...languages].sort() };
}

export function buildFilesResponse(cwd: string, envelope: IndexEnvelope): ToolResponsePayload {
  const structural = envelope.structuralIndex;

  if (envelope.state === "falha" || !structural) {
    return {
      tree: [],
      languages: [],
      storage_backend: envelope.storage_backend,
      schema_version: envelope.schema_version,
      ...stubResponse(envelope.state, envelope.message, {
        limitations: envelope.limitations,
        staleness_hint: envelope.staleness_hint,
      }),
    };
  }

  const metadata = readWorkspaceMetadata(cwd);
  if (!metadata) {
    return {
      tree: [],
      languages: [],
      storage_backend: envelope.storage_backend,
      schema_version: envelope.schema_version,
      ...stubResponse("falha", WORKSPACE_MISSING),
    };
  }
  const db = openIndexDb(getIndexDbPath(metadata.root_path), { readonly: true });
  let tree: FileTreeNode[];
  let languages: string[];
  try {
    ({ tree, languages } = fileTreeFromRows(readFileTreeRows(db)));
  } finally {
    closeIndexDb(db);
  }

  if (envelope.state === "stale") {
    return {
      tree,
      languages,
      storage_backend: envelope.storage_backend,
      schema_version: envelope.schema_version,
      ...stubResponse("stale", envelope.message, {
        limitations: envelope.limitations,
        staleness_hint: envelope.staleness_hint,
      }),
    };
  }

  const structuralLimitations = mergeStructuralLimitations(structural);
  if (structuralLimitations.length > 0) {
    return {
      tree,
      languages,
      storage_backend: envelope.storage_backend,
      schema_version: envelope.schema_version,
      ...stubResponse("parcial", "Estrutura indexada com limitações de cobertura.", {
        limitations: structuralLimitations,
      }),
    };
  }

  return {
    tree,
    languages,
    storage_backend: envelope.storage_backend,
    schema_version: envelope.schema_version,
    ...stubResponse("sucesso", "Estrutura indexada com contagens de símbolos por arquivo."),
  };
}

export function applyFilesFilters(
  tree: Array<{ path: string; symbol_counts?: unknown }>,
  args?: FilesArgs,
): Array<{ path: string; symbol_counts?: unknown }> {
  let filtered = tree;

  if (args?.pattern) {
    const pattern = args.pattern.toLowerCase();
    filtered = filtered.filter((entry) => entry.path.toLowerCase().includes(pattern));
  }

  if (typeof args?.max_depth === "number") {
    filtered = filtered.filter((entry) => entry.path.split("/").length - 1 <= args.max_depth!);
  }

  return filtered;
}
