import { VaultEngine } from "../../memory/vault-engine.js";
import type { Embedder } from "../../embeddings/embedder.js";
import type { ToolResponsePayload } from "./common.js";

export interface RecallArgs {
  query?: string;
  limit?: number;
  include_snippets?: boolean;
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
  return VaultEngine.search(query, {
    limit: args?.limit,
    includeSnippets: args?.include_snippets,
  }, cwd);
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
  return VaultEngine.recall(query, {
    limit: args?.limit,
    includeSnippets: args?.include_snippets,
  }, cwd, embedder);
}
