import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { getCodeIndexPath, getMemoryConfigPath, getMemoryDbPath, getVaultDir } from "./paths.js";

export interface MemoryConfig {
  vault_path: string;
  db_path: string;
  llm_provider: "none" | "openai" | "anthropic" | string;
  code_index_path?: string | null;
  embed_model?: string;
  llm_model?: string;
  openai_api_key?: string;
  anthropic_api_key?: string;
  max_context_tokens?: number;
  dream_similarity_threshold?: number;
  dream_max_notes_per_run?: number;
  dream_batch_sleep_ms?: number;
}

export const DEFAULT_MAX_CONTEXT_TOKENS = 8_000;
export const DEFAULT_LLM_MODEL_OPENAI = "gpt-4o-mini";
export const DEFAULT_LLM_MODEL_ANTHROPIC = "claude-3-5-haiku-latest";

export function defaultMemoryConfig(cwd: string = process.cwd()): MemoryConfig {
  return {
    vault_path: getVaultDir(cwd),
    db_path: getMemoryDbPath(cwd),
    llm_provider: "none",
    code_index_path: getCodeIndexPath(cwd),
    embed_model: "Xenova/bge-small-en-v1.5",
  };
}

export function loadMemoryConfig(cwd: string = process.cwd()): MemoryConfig | null {
  const path = getMemoryConfigPath(cwd);
  if (!existsSync(path)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as MemoryConfig;
  } catch {
    return null;
  }
}

export function writeMemoryConfig(config: MemoryConfig, cwd: string = process.cwd()): void {
  const path = getMemoryConfigPath(cwd);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n", "utf-8");
}
