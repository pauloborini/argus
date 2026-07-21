import { VaultEngine } from "../../memory/vault-engine.js";
import type { Embedder } from "../../embeddings/embedder.js";
import { resolveLocalStateRoot } from "../../workspace/resolve-workspace.js";
import { WORKSPACE_MISSING, type ToolResponsePayload } from "./common.js";

export interface RememberArgs {
  content?: string;
  type?: "inbox" | "decision" | "meeting" | "entity" | "project" | "reference";
  tags?: string[];
  links?: string[];
}

export async function buildRememberResponse(
  cwd: string,
  args?: RememberArgs,
  embedder?: Embedder,
): Promise<ToolResponsePayload> {
  const rootPath = resolveLocalStateRoot(cwd)?.rootPath;
  if (!rootPath) {
    return {
      state: "falha",
      message: WORKSPACE_MISSING,
    };
  }
  return VaultEngine.remember(
    args?.content ?? "",
    {
      type: args?.type,
      tags: args?.tags,
      links: args?.links,
      embedder,
    },
    rootPath,
  );
}
