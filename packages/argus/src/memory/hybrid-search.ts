import { VaultEngine } from "./vault-engine.js";

export const DEFAULT_W_FTS = 0.6;
export const DEFAULT_W_VEC = 0.4;

export function hybridSearch(query: string, options?: { limit?: number }, cwd: string = process.cwd()) {
  return VaultEngine.search(query, options, cwd);
}

