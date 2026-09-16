import { VaultEngine } from "../../memory/vault-engine.js";
import type { Embedder } from "../../embeddings/embedder.js";
import { resolveLocalStateRoot } from "../../workspace/resolve-workspace.js";
import { WORKSPACE_MISSING, type ToolResponsePayload } from "./common.js";

export interface RecallArgs {
  query?: string;
  limit?: number;
  include_snippets?: boolean;
  as_of?: string;
}

const ISO_8601_REGEX = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}(?::?\d{2})?)?)?$/;

function isValidIsoDateTime(value: string): boolean {
  if (typeof value !== "string" || !value.trim()) {
    return false;
  }
  if (!ISO_8601_REGEX.test(value)) {
    return false;
  }
  return Number.isFinite(Date.parse(value));
}

export function buildRecallResponse(cwd: string, args?: RecallArgs): ToolResponsePayload {
  const query = args?.query?.trim() ?? "";
  if (!query) {
    return {
      mechanism: "fts-only",
      chunks: [],
      state: "falha",
      message: "E_MEMORY_INPUT_INVALID: query vazia.",
      confidence: "low",
    };
  }
  if (args?.as_of !== undefined && !isValidIsoDateTime(args.as_of)) {
    return {
      mechanism: "fts-only",
      chunks: [],
      state: "falha",
      message: "E_MEMORY_INPUT_INVALID: as_of precisa ser ISO 8601.",
      confidence: "low",
    };
  }
  const rootPath = resolveLocalStateRoot(cwd)?.rootPath;
  if (!rootPath) {
    return { state: "falha", message: WORKSPACE_MISSING };
  }
  return VaultEngine.search(query, {
    limit: args?.limit,
    includeSnippets: args?.include_snippets,
    asOf: args?.as_of,
  }, rootPath);
}

export async function buildRecallResponseAsync(
  cwd: string,
  args?: RecallArgs,
  embedder?: Embedder,
): Promise<ToolResponsePayload> {
  const query = args?.query?.trim() ?? "";
  if (!query) {
    return buildRecallResponse(cwd, args);
  }
  if (args?.as_of !== undefined && !isValidIsoDateTime(args.as_of)) {
    return {
      mechanism: "fts-only",
      chunks: [],
      state: "falha",
      message: "E_MEMORY_INPUT_INVALID: as_of precisa ser ISO 8601.",
      confidence: "low",
    };
  }
  const rootPath = resolveLocalStateRoot(cwd)?.rootPath;
  if (!rootPath) {
    return { state: "falha", message: WORKSPACE_MISSING };
  }
  return VaultEngine.recall(query, {
    limit: args?.limit,
    includeSnippets: args?.include_snippets,
    asOf: args?.as_of,
  }, rootPath, embedder);
}
