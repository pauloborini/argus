import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runIndex } from "../src/commands/index-cmd.js";
import { buildToolStub } from "../src/mcp/tools/stubs.js";
import { initWorkspace } from "../src/workspace/workspace.js";

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
  });

  it("status após index fica fresh/sucesso", () => {
    const root = setupWorkspace();
    expect(runIndex()).toBe(0);
    const payload = buildToolStub("status", root);
    expect(payload.state).toBe("sucesso");
    expect(payload.staleness).toBe("fresh");
    expect(payload.pending_files_count).toBe(0);
    expect(typeof payload.index_version).toBe("string");
  });

  it("status detecta stale quando arquivo muda", () => {
    const root = setupWorkspace();
    expect(runIndex()).toBe(0);
    writeFileSync(join(root, "main.ts"), "export const main = false;\n", "utf-8");
    const payload = buildToolStub("status", root);
    expect(payload.state).toBe("stale");
    expect(payload.staleness).toBe("stale");
    expect(Number(payload.pending_files_count)).toBeGreaterThan(0);
  });

  it("tools semânticas degradam para stale quando manifest está desatualizado", () => {
    const root = setupWorkspace();
    expect(runIndex()).toBe(0);
    writeFileSync(join(root, "main.ts"), "export const main = false;\n", "utf-8");

    const searchPayload = buildToolStub("search", root);
    expect(searchPayload.state).toBe("stale");
    expect(String(searchPayload.message)).toContain("E_STALE_INDEX");
    expect(String(searchPayload.staleness_hint)).toContain("cortex sync");

    const packPayload = buildToolStub("pack_context", root);
    expect(packPayload.state).toBe("stale");
    expect(String(packPayload.message)).toContain("E_STALE_INDEX");
  });

  it("status degradado quando manifest está corrompido", () => {
    const root = setupWorkspace();
    expect(runIndex()).toBe(0);
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
});
