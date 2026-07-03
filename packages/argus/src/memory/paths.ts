import { join, resolve } from "node:path";
import {
  getIndexDbPath,
  getWorkspacePath,
  MEMORY_CONFIG_FILE,
  MEMORY_DB_FILE,
  MEMORY_DIR,
  MEMORY_VAULT_DIR,
} from "../workspace/workspace.js";

export const VAULT_SUBDIRS = [
  "entities",
  "meetings",
  "decisions",
  "projects",
  "references",
  "inbox",
] as const;

export type VaultSubdir = (typeof VAULT_SUBDIRS)[number];

let customMemoryRoot: string | null = null;

export function setCustomMemoryRoot(path: string | null): void {
  customMemoryRoot = path ? resolve(path) : null;
}

export function getMemoryRoot(cwd: string = process.cwd()): string {
  return customMemoryRoot ?? process.env.ARGUS_MEMORY_PATH ?? join(getWorkspacePath(cwd), MEMORY_DIR);
}

export function getVaultDir(cwd: string = process.cwd()): string {
  return join(getMemoryRoot(cwd), MEMORY_VAULT_DIR);
}

export function getMemoryDbPath(cwd: string = process.cwd()): string {
  return join(getMemoryRoot(cwd), MEMORY_DB_FILE);
}

export function getMemoryConfigPath(cwd: string = process.cwd()): string {
  return join(getMemoryRoot(cwd), MEMORY_CONFIG_FILE);
}

export function getLegacyAthenaDir(cwd: string = process.cwd()): string {
  return join(resolve(cwd), ".athena");
}

export function getCodeIndexPath(cwd: string = process.cwd()): string {
  return getIndexDbPath(cwd);
}

