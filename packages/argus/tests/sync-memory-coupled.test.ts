import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runIndex } from "../src/commands/index-cmd.js";
import { runSync } from "../src/commands/sync.js";
import { VaultEngine } from "../src/memory/vault-engine.js";
import { closeMemoryDb, openMemoryDb } from "../src/memory/storage/sqlite-db.js";
import { buildStatusResponse } from "../src/mcp/tools/status.js";
import { initWorkspace } from "../src/workspace/workspace.js";

/**
 * Todo caminho de sync estrutural (CLI, daemon watch, MCP auto-sync) passa por
 * `runSync`. Este teste ancora o contrato: após qualquer sync bem-sucedido,
 * `memory.last_sync_at` e `structural_status.last_sync_at` ficam recentes no
 * mesmo root — mesmo em no-op de conteúdo.
 */
describe("sync acopla índice + cofre", () => {
  let tempDir: string | undefined;
  let originalCwd: string | undefined;

  afterEach(() => {
    if (originalCwd) {
      process.chdir(originalCwd);
      originalCwd = undefined;
    }
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  function setup(): string {
    originalCwd = process.cwd();
    tempDir = mkdtempSync(join(tmpdir(), "argus-sync-mem-"));
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(join(tempDir, "app.ts"), "export const app = 1;\n", "utf-8");
    initWorkspace(tempDir);
    process.chdir(tempDir);
    return tempDir;
  }

  function ageMemoryLastSync(root: string, iso: string): void {
    const db = openMemoryDb(root);
    try {
      db.prepare("UPDATE memory_meta SET last_sync_at = ? WHERE id = 1").run(iso);
    } finally {
      closeMemoryDb(db);
    }
  }

  function assertBothRecent(root: string): void {
    const status = buildStatusResponse(root);
    const structural = status.structural_status as { last_sync_at: string | null };
    const memory = status.memory as { last_sync_at: string | null; initialized?: boolean };
    expect(memory.initialized).toBe(true);
    expect(structural.last_sync_at).toBeTruthy();
    expect(memory.last_sync_at).toBeTruthy();
    const now = Date.now();
    expect(now - Date.parse(structural.last_sync_at!)).toBeLessThan(60_000);
    expect(now - Date.parse(memory.last_sync_at!)).toBeLessThan(60_000);
  }

  it("runSync no-op atualiza last_sync_at do cofre no mesmo root", async () => {
    const root = setup();
    expect(await runIndex()).toBe(0);
    VaultEngine.init(root);
    VaultEngine.sync(root);
    ageMemoryLastSync(root, new Date(Date.now() - 4 * 3_600_000).toISOString());

    const before = buildStatusResponse(root).memory as { last_sync_at: string };
    expect(Date.now() - Date.parse(before.last_sync_at)).toBeGreaterThan(3 * 3_600_000);

    expect(await runSync({ quiet: true })).toBe(0);
    assertBothRecent(root);
  });

  it("runSync via paths (daemon/watch) também sincroniza o cofre", async () => {
    const root = setup();
    expect(await runIndex()).toBe(0);
    VaultEngine.init(root);
    VaultEngine.sync(root);
    ageMemoryLastSync(root, new Date(Date.now() - 4 * 3_600_000).toISOString());

    writeFileSync(join(root, "app.ts"), "export const app = 2;\n", "utf-8");
    expect(await runSync({ cwd: root, paths: [join(root, "app.ts")], quiet: true })).toBe(0);
    assertBothRecent(root);
  });
});
