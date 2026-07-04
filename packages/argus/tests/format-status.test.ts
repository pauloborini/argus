import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatDaemonStatusHuman, formatRepoStatusHuman } from "../src/commands/format-status.js";
import { initWorkspace } from "../src/workspace/workspace.js";

describe("format-status", () => {
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
    tempDir = mkdtempSync(join(tmpdir(), "argus-format-status-"));
    initWorkspace(tempDir);
    process.chdir(tempDir);
    return tempDir;
  }

  it("formata status humano com seções e cobertura", () => {
    const root = setupWorkspace();
    const text = formatRepoStatusHuman(
      {
        initialized: true,
        state: "parcial",
        staleness: "fresh",
        pending_files_count: 0,
        storage_backend: "sqlite",
        schema_version: "1.0.0",
        coverage_by_language: {
          dart: {
            files_eligible: 1984,
            files_parsed: 1733,
            symbols: 27722,
            coverage_level: "full",
          },
        },
        memory: {
          initialized: true,
          staleness: "fresh",
          notes_count: 0,
          last_sync_at: null,
          embeddings_ready: false,
          schema_v2_ready: true,
        },
      },
      root,
    );

    expect(text).toContain(`Repositório: ${root}`);
    expect(text).toContain("Índice estrutural:");
    expect(text).toContain("utilizável com ressalvas");
    expect(text).toContain("Cobertura por linguagem:");
    expect(text).toContain("1733 de 1984 arquivos indexados");
    expect(text).toContain("Memória (cofre local");
    expect(text).toContain("Busca semântica:");
    expect(text).not.toContain("coverage_by_language");
  });

  it("daemon status foca no workspace atual", () => {
    const root = setupWorkspace();
    const other = mkdtempSync(join(tmpdir(), "argus-format-status-other-"));
    const text = formatDaemonStatusHuman(
      42,
      {
        pid: 42,
        started_at: new Date(Date.now() - 3_600_000).toISOString(),
        updated_at: new Date().toISOString(),
        workspaces: [
          {
            root: other,
            watching: true,
            last_sync_at: new Date().toISOString(),
            last_sync_paths: 1,
            last_sync_ok: true,
            last_sync_duration_ms: 100,
            last_event_at: new Date().toISOString(),
            last_error: null,
            watch_backend: "parcel-watcher",
          },
          {
            root,
            watching: true,
            last_sync_at: new Date().toISOString(),
            last_sync_paths: 2,
            last_sync_ok: true,
            last_sync_duration_ms: 402,
            last_event_at: new Date().toISOString(),
            last_error: null,
            watch_backend: "parcel-watcher",
          },
        ],
      },
      { cwd: root },
    );

    expect(text).toContain("Daemon de auto-sync: rodando");
    expect(text).toContain(`Repositório observado: ${root}`);
    expect(text).not.toContain(`Repositório observado: ${other}`);
    expect(text).toContain("(+1 outro repositório");
    rmSync(other, { recursive: true, force: true });
  });
});
