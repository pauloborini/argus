import { VaultEngine } from "../../memory/vault-engine.js";
import type { ToolResponsePayload } from "./common.js";

export interface RememberArgs {
  content?: string;
  type?: "inbox" | "decision" | "meeting" | "entity" | "project" | "reference";
  tags?: string[];
  links?: string[];
}

export function buildRememberResponse(cwd: string, args?: RememberArgs): ToolResponsePayload {
  return VaultEngine.remember(args?.content ?? "", {
    type: args?.type,
    tags: args?.tags,
    links: args?.links,
  }, cwd);
}

