import { existsSync, cpSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { defaultMemoryConfig } from "./config.js";
import { getLegacyAthenaDir, getMemoryConfigPath, getMemoryDbPath, getMemoryRoot, getVaultDir } from "./paths.js";

export type LegacyAthenaMigrationStatus =
  | "skipped"
  | "migrated"
  | "skipped_existing_destination"
  | "failed";

export interface LegacyAthenaMigrationResult {
  status: LegacyAthenaMigrationStatus;
  message: string;
}

function rewriteConfig(cwd: string, sourceConfig: string | null): string {
  let config: Record<string, unknown> = {};
  if (sourceConfig && existsSync(sourceConfig)) {
    try {
      config = JSON.parse(readFileSync(sourceConfig, "utf-8")) as Record<string, unknown>;
    } catch {
      config = {};
    }
  }
  delete config.argus_db_path;
  return JSON.stringify(
    {
      ...defaultMemoryConfig(cwd),
      ...config,
      vault_path: getVaultDir(cwd),
      db_path: getMemoryDbPath(cwd),
      code_index_path: defaultMemoryConfig(cwd).code_index_path,
    },
    null,
    2,
  ) + "\n";
}

export function migrateLegacyAthena(cwd: string = process.cwd()): LegacyAthenaMigrationResult {
  const legacy = getLegacyAthenaDir(cwd);
  if (!existsSync(legacy)) {
    return { status: "skipped", message: "Sem .athena legado." };
  }
  const memoryRoot = getMemoryRoot(cwd);
  if (existsSync(memoryRoot)) {
    return { status: "skipped_existing_destination", message: ".argus/memory já existe; migração ignorada." };
  }

  const tmp = `${memoryRoot}.migrating-${process.pid}-${Date.now()}`;
  try {
    mkdirSync(tmp, { recursive: true });
    const legacyVault = join(legacy, "vault");
    if (existsSync(legacyVault)) {
      cpSync(legacyVault, join(tmp, "vault"), { recursive: true });
    }
    const legacyDb = join(legacy, "athena-vault.db");
    if (existsSync(legacyDb)) {
      cpSync(legacyDb, join(tmp, "legacy-athena-vault.db"));
    }
    writeFileSync(join(tmp, basename(getMemoryConfigPath(cwd))), rewriteConfig(cwd, join(legacy, "config.json")), "utf-8");
    mkdirSync(dirname(memoryRoot), { recursive: true });
    renameSync(tmp, memoryRoot);
    return { status: "migrated", message: ".athena migrado para .argus/memory." };
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true });
    return {
      status: "failed",
      message: `E_ATHENA_MIGRATION_FAILED: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
