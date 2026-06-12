import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runIndex } from "../src/commands/index-cmd.js";
import { buildToolStub } from "../src/mcp/tools/stubs.js";
import { SQLITE_SCHEMA_VERSION } from "../src/storage/sqlite-prepared.js";
import { getIndexDbPath, initWorkspace } from "../src/workspace/workspace.js";

describe("status stub e staleness", () => {
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

  function setupWorkspace(): string {
    originalCwd = process.cwd();
    tempDir = mkdtempSync(join(tmpdir(), "cortex-status-"));
    writeFileSync(join(tempDir, "main.ts"), "export const main = true;\n", "utf-8");
    initWorkspace(tempDir);
    process.chdir(tempDir);
    return tempDir;
  }

  it("status sem manifest fica unknown/parcial", () => {
    const root = setupWorkspace();
    const payload = buildToolStub("status", root);
    expect(payload.initialized).toBe(true);
    expect(payload.state).toBe("parcial");
    expect(payload.staleness).toBe("unknown");
    expect(payload.index_version).toBeNull();
    expect(payload.storage_backend).toBeNull();
  });

  it("status reporta limitations quando há arquivos não suportados no manifest", async () => {
    const root = setupWorkspace();
    writeFileSync(join(root, "notes.md"), "# notes\n", "utf-8");
    expect(await runIndex()).toBe(0);

    const payload = buildToolStub("status", root);
    expect(payload.state).toBe("parcial");
    const limitations = payload.limitations as string[];
    expect(limitations.some((line) => line.includes("não suportada"))).toBe(true);
  });

  it("status após index fica fresh/sucesso com coverage e backend sqlite", async () => {
    const root = setupWorkspace();
    expect(await runIndex()).toBe(0);
    const payload = buildToolStub("status", root);
    expect(payload.state).toBe("sucesso");
    expect(payload.staleness).toBe("fresh");
    expect(payload.pending_files_count).toBe(0);
    expect(payload.storage_backend).toBe("sqlite");
    expect(payload.schema_version).toBe(SQLITE_SCHEMA_VERSION);
    expect(typeof payload.index_version).toBe("string");
    expect(String(payload.index_version)).toContain("sqlite@");
    const coverage = payload.coverage_by_language as Record<string, { symbols: number }>;
    expect(coverage.typescript?.symbols).toBeGreaterThan(0);
  });

  it("status detecta stale quando arquivo muda", async () => {
    const root = setupWorkspace();
    expect(await runIndex()).toBe(0);
    writeFileSync(join(root, "main.ts"), "export const main = false;\n", "utf-8");
    const payload = buildToolStub("status", root);
    expect(payload.state).toBe("stale");
    expect(payload.staleness).toBe("stale");
    expect(Number(payload.pending_files_count)).toBeGreaterThan(0);
  });

  it("tools semânticas degradam honestamente com índice SQLite", async () => {
    const root = setupWorkspace();
    expect(await runIndex()).toBe(0);

    const searchPayload = buildToolStub("search", root);
    expect(searchPayload.state).toBe("parcial");
    expect(searchPayload.candidates).toEqual([]);
    expect(String(searchPayload.message)).toContain("S08");

    const packPayload = buildToolStub("pack_context", root);
    expect(packPayload.state).toBe("parcial");
    expect(packPayload.packed_context).toBeNull();
  });

  it("status degradado quando manifest está corrompido", async () => {
    const root = setupWorkspace();
    expect(await runIndex()).toBe(0);
    const manifestPath = join(root, ".cortex", "file-manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
      schema_version: string;
      generated_at: string;
      root_path: string;
      file_count: number;
      files: unknown[];
    };
    manifest.files = [{ relative_path: "main.ts", content_hash: 123, size_bytes: "22", mtime_ms: null }];
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf-8");

    const payload = buildToolStub("status", root);
    expect(payload.state).toBe("parcial");
    expect(payload.staleness).toBe("unknown");
    expect(String(payload.message)).toContain("E_INDEX_CORRUPTED");
  });

  it("status falha quando banco SQLite está corrompido", async () => {
    const root = setupWorkspace();
    expect(await runIndex()).toBe(0);
    writeFileSync(getIndexDbPath(root), "not-a-sqlite-db", "utf-8");

    const payload = buildToolStub("status", root);
    expect(payload.state).toBe("falha");
    expect(String(payload.message)).toContain("E_INDEX_CORRUPTED");
  });
});
