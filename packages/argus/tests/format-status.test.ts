import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatDaemonStatusHuman, formatRepoStatusHuman } from "../src/commands/format-status.js";
import { runIndex } from "../src/commands/index-cmd.js";
import { runSync } from "../src/commands/sync.js";
import { buildToolResponse } from "../src/mcp/tools/response.js";
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

describe("Plano 6 — UX de status: cofre vs índice (AC-6.1.*, INV-W7)", () => {
  let tempDir: string | undefined;
  let originalCwd: string | undefined;

  afterEach(() => {
    vi.useRealTimers();
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
    tempDir = mkdtempSync(join(tmpdir(), "argus-plano6-"));
    initWorkspace(tempDir);
    process.chdir(tempDir);
    return tempDir;
  }

  it("AC-6.1.1: saída humana qualifica cofre vs índice; não usa 'Última sincronização' genérico", () => {
    const root = setupWorkspace();
    const recentIso = new Date(Date.now() - 60_000).toISOString();
    const oldMemoryIso = new Date(Date.now() - 8 * 3_600_000).toISOString();
    const text = formatRepoStatusHuman(
      {
        initialized: true,
        state: "sucesso",
        staleness: "fresh",
        pending_files_count: 0,
        storage_backend: "sqlite",
        schema_version: "1.0.0",
        coverage_by_language: {},
        // cofre antigo (8h atrás) — é a origem da ambiguidade do bug.
        memory: {
          initialized: true,
          staleness: "stale",
          notes_count: 5,
          last_sync_at: oldMemoryIso,
          embeddings_ready: false,
          schema_v2_ready: true,
        },
        // índice estrutural recentemente sincronizado.
        structural_status: { last_sync_at: recentIso },
      },
      root,
    );

    // INV-W7: a frase genérica "Última sincronização:" não aparece sem qualificar.
    expect(text).not.toMatch(/Última sincronização:/);

    // Rótulos distintos cofre vs índice.
    expect(text).toContain("Última sync do índice:");
    expect(text).toContain("Última sync do cofre:");
    expect(text).toContain("Sincronização do cofre:");
    expect(text).toContain("Sincronização com o código:");
  });

  it("AC-6.1.2: pós-sync, índice e cofre ficam recentes (mesmo processo, mesmo root)", async () => {
    const root = setupWorkspace();
    // Cofre envelhecido 8 h no passado; sync estrutural deve forçar sync do cofre.
    const { VaultEngine } = await import("../src/memory/vault-engine.js");
    const staleTime = new Date(Date.now() - 8 * 3_600_000);
    vi.useFakeTimers();
    vi.setSystemTime(staleTime);
    await VaultEngine.remember(
      "decisão antiga do projeto",
      { type: "decision", tags: ["old"] },
      root,
    );
    VaultEngine.sync(root);
    vi.useRealTimers();

    expect(await runIndex()).toBe(0);

    writeFileSync(join(root, "feature.ts"), "export const feature = true;\n", "utf-8");
    expect(await runSync()).toBe(0);

    const payload = buildToolResponse("status", root, { response_format: "detailed" });
    const text = formatRepoStatusHuman(payload, root);

    // Ambos os timestamps refletem o sync que acabou de rodar — não "há 8 h".
    const cofreLine = text.split("\n").find((l) => l.startsWith("  Última sync do cofre:"));
    const indexLine = text.split("\n").find((l) => l.startsWith("  Última sync do índice:"));
    expect(cofreLine).toBeDefined();
    expect(indexLine).toBeDefined();
    expect(cofreLine).not.toMatch(/há [0-9]+ h/);
    expect(indexLine).not.toMatch(/há [0-9]+ h/);
    expect(cofreLine!).toMatch(/(agora|há \d+ min)/);
    expect(indexLine!).toMatch(/(agora|há \d+ min)/);

    const memory = payload.memory as { last_sync_at: string | null };
    const structural = payload.structural_status as { last_sync_at: string };
    expect(memory.last_sync_at).toBeTruthy();
    const memMs = Date.parse(memory.last_sync_at!);
    const structMs = Date.parse(structural.last_sync_at);
    expect(Date.now() - memMs).toBeLessThan(60_000);
    expect(Date.now() - structMs).toBeLessThan(60_000);
  });

  it("AC-6.1.3 / INV-W7: com índice fresh, saída não induz usuário a rodar sync estrutural", async () => {
    const root = setupWorkspace();
    expect(await runIndex()).toBe(0);
    // Sync subsequente garante manifest + generated_at reescrito.
    expect(await runSync()).toBe(0);

    const payload = buildToolResponse("status", root, { response_format: "detailed" });
    expect(payload.state).toBe("sucesso");
    expect(payload.staleness).toBe("fresh");

    const text = formatRepoStatusHuman(payload, root);

    // Com índice fresh, a hint STALE_RUN_SYNC não deve aparecer na saída humana.
    expect(text).not.toContain("STALE_RUN_SYNC");
    expect(text).not.toMatch(/Execute argus sync para sincronizar o delta pendente/);
    // Seção "Próximo passo" não deve existir quando state=sucesso.
    expect(text).not.toContain("Próximo passo:");

    // Campos distintos no JSON (rótulos separados); após sync ambos recentes.
    expect(payload.structural_status).toBeDefined();
    expect((payload.structural_status as { last_sync_at: string }).last_sync_at).toBeTruthy();
    const memory = payload.memory as { last_sync_at: string | null };
    expect(memory.last_sync_at).toBeTruthy();
    expect(Date.now() - Date.parse(memory.last_sync_at!)).toBeLessThan(60_000);
    expect(
      Date.now() - Date.parse((payload.structural_status as { last_sync_at: string }).last_sync_at),
    ).toBeLessThan(60_000);
  });

  it("INV-W7: rótulos não misturam cofre e índice mesmo com cofre não inicializado", () => {
    const root = setupWorkspace();
    const recentIso = new Date().toISOString();
    const text = formatRepoStatusHuman(
      {
        initialized: true,
        state: "sucesso",
        staleness: "fresh",
        pending_files_count: 0,
        storage_backend: "sqlite",
        schema_version: "1.0.0",
        coverage_by_language: {},
        memory: {
          initialized: false,
          staleness: "unknown",
          notes_count: 0,
          last_sync_at: null,
          embeddings_ready: false,
        },
        structural_status: { last_sync_at: recentIso },
      },
      root,
    );

    // O índice mostra timestamp recente; o cofre mostra estado não inicializado.
    expect(text).toContain("Última sync do índice: agora");
    expect(text).toContain("Estado: não inicializada");
    // A frase genérica "Última sincronização:" não deve aparecer.
    expect(text).not.toMatch(/Última sincronização:/);
  });
});
