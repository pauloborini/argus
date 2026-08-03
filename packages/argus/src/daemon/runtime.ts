import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  daemonPidPath,
  daemonStatusPath,
  userStateDir,
} from "../workspace/user-paths.js";
import { hasDirtyPaths } from "../discovery/dirty-flag.js";
import { runSync } from "../commands/sync.js";
import { workspaceExists } from "../workspace/workspace.js";
import { listWorkspaceRoots } from "./registry.js";
import { WorkspacePipeline } from "./pipeline.js";
import {
  eventsSince,
  subscribeWorkspace,
  writeWatchSnapshot,
  type WorkspaceSubscription,
} from "./watcher.js";
import { acquireDaemonLock } from "./lock.js";
import { loadMemoryConfig, resolveDreamSchedule } from "../memory/config.js";
import { DreamEngine } from "../memory/dream-engine.js";
import { getVaultDir } from "../memory/paths.js";
import type { ToolResponsePayload } from "../mcp/tools/common.js";

const DEFAULT_DEBOUNCE_MS = 400;
const DEFAULT_MAX_DEBOUNCE_MS = 3_000;
const STATUS_INTERVAL_MS = 15_000;
const SNAPSHOT_INTERVAL_MS = 30_000;
const MAX_RESUBSCRIBE_BACKOFF_MS = 30_000;
const POLL_INTERVAL_MS = 30_000;
/** How often the daemon re-checks per-workspace dream eligibility (not the dream interval itself). */
const DEFAULT_DREAM_TICK_INTERVAL_MS = 60_000;

/**
 * Reconhece exaustão de watches do SO (inotify no Linux, descritores no
 * macOS/BSD). Quando o backend nativo estoura, resubscrever rápido só queima
 * CPU — o limite é do SO, não transitório. Retorna `null` para erros comuns.
 */
export function watcherExhaustionHint(err: Error): string | null {
  const text = `${(err as NodeJS.ErrnoException).code ?? ""} ${err.message}`;
  if (/ENOSPC|EMFILE|ENFILE|inotify|too many open files|watch(?:er)? limit/i.test(text)) {
    return (
      "Limite de watches do SO esgotado (ENOSPC/EMFILE). " +
      "Aumente fs.inotify.max_user_watches (Linux) ou o limite de descritores; " +
      "auto-sync degradou para polling a cada 30s até o limite subir."
    );
  }
  return null;
}

export type DreamRunMode = "dry-run" | "apply";

export type DreamRunner = (
  cwd: string,
  options: { dryRun?: boolean },
) => Promise<ToolResponsePayload>;

interface WorkspaceState {
  root: string;
  pipeline: WorkspacePipeline;
  subscription: WorkspaceSubscription | null;
  snapshotPath: string;
  watching: boolean;
  resubscribeBackoffMs: number;
  lastSyncAt: string | null;
  lastSyncPaths: number;
  lastSyncOk: boolean | null;
  lastSyncDurationMs: number | null;
  lastEventAt: string | null;
  lastError: string | null;
  watchBackend: "parcel-watcher" | "poll" | "off";
  pollTimer: NodeJS.Timeout | null;
  lastDreamAt: string | null;
  lastDreamOk: boolean | null;
  lastDreamMode: DreamRunMode | null;
  lastDreamError: string | null;
  dreamScheduleEnabled: boolean | null;
  dreamRunning: boolean;
}

export interface DaemonRuntimeOptions {
  debounceMs?: number;
  maxDebounceMs?: number;
  /** Override do intervalo do tick de verificação do schedule (testes / ops). */
  dreamTickIntervalMs?: number;
  /** Injeta o runner de dream (default: DreamEngine.run). */
  dreamRunner?: DreamRunner;
  /** Relógio injetável (epoch ms) para testes de intervalo. */
  now?: () => number;
  /** Quando false, `stop()` não chama `process.exit` (testes). Default true. */
  exitProcessOnStop?: boolean;
  /** Quando false, não abre watchers FS (testes de schedule). Default true. */
  enableWatchers?: boolean;
}

/** Estado serializável publicado no status file para `argus daemon status`. */
export interface DaemonStatusSnapshot {
  pid: number;
  started_at: string;
  updated_at: string;
  workspaces: {
    root: string;
    watching: boolean;
    last_sync_at: string | null;
    last_sync_paths: number;
    last_sync_ok: boolean | null;
    last_sync_duration_ms: number | null;
    last_event_at: string | null;
    last_error: string | null;
    watch_backend: "parcel-watcher" | "poll" | "off";
    last_dream_at: string | null;
    last_dream_ok: boolean | null;
    last_dream_mode: DreamRunMode | null;
    last_dream_error: string | null;
    dream_schedule_enabled: boolean | null;
  }[];
}

function snapshotPathFor(root: string): string {
  const hash = createHash("sha1").update(root).digest("hex").slice(0, 16);
  return join(userStateDir(), `snap-${hash}.txt`);
}

function writeFileAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content, "utf-8");
  renameSync(tmp, path);
}

/**
 * Runtime foreground do daemon: observa todos os workspaces registrados,
 * coalesce eventos por debounce e mantém o índice fresco por delta de paths.
 * Resiliente a queda de backend (resubscribe com backoff) e a downtime
 * (catch-up por snapshot no boot). Encerra limpo em SIGTERM/SIGINT e recarrega
 * o registry em SIGHUP. Agenda dream periódico (dry-run por default) por workspace.
 */
export class DaemonRuntime {
  private readonly states = new Map<string, WorkspaceState>();
  private readonly debounceMs: number;
  private readonly maxDebounceMs: number;
  private readonly dreamTickIntervalMs: number;
  private readonly dreamRunner: DreamRunner;
  private readonly nowFn: () => number;
  private readonly exitProcessOnStop: boolean;
  private readonly enableWatchers: boolean;
  private readonly startedAt = new Date().toISOString();
  private statusTimer: NodeJS.Timeout | null = null;
  private snapshotTimer: NodeJS.Timeout | null = null;
  private dreamTimer: NodeJS.Timeout | null = null;
  private daemonLockRelease: (() => void) | null = null;
  private stopping = false;

  constructor(options: DaemonRuntimeOptions = {}) {
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.maxDebounceMs = options.maxDebounceMs ?? DEFAULT_MAX_DEBOUNCE_MS;
    this.dreamTickIntervalMs = options.dreamTickIntervalMs ?? DEFAULT_DREAM_TICK_INTERVAL_MS;
    this.dreamRunner = options.dreamRunner ?? ((cwd, opts) => DreamEngine.run(cwd, opts));
    this.nowFn = options.now ?? (() => Date.now());
    this.exitProcessOnStop = options.exitProcessOnStop ?? true;
    this.enableWatchers = options.enableWatchers ?? true;
  }

  async start(): Promise<boolean> {
    mkdirSync(userStateDir(), { recursive: true });
    this.daemonLockRelease = acquireDaemonLock();
    if (!this.daemonLockRelease) {
      console.error("Daemon já em execução; instância duplicada abortada.");
      return false;
    }
    writeFileAtomic(daemonPidPath(), String(process.pid));

    await this.reloadRegistry();

    this.statusTimer = setInterval(() => this.writeStatus(), STATUS_INTERVAL_MS);
    this.snapshotTimer = setInterval(() => void this.refreshSnapshots(), SNAPSHOT_INTERVAL_MS);
    this.dreamTimer = setInterval(() => void this.tickDreamSchedules(), this.dreamTickIntervalMs);
    this.writeStatus();
    // Primeiro tick assíncrono sem esperar o intervalo (testes / boot).
    void this.tickDreamSchedules();

    process.on("SIGHUP", () => void this.reloadRegistry());
    process.on("SIGTERM", () => void this.stop(0));
    process.on("SIGINT", () => void this.stop(0));
    return true;
  }

  /** Snapshot atual (também usado por testes sem ler o arquivo de status). */
  getStatusSnapshot(): DaemonStatusSnapshot {
    return this.buildStatusSnapshot();
  }

  /** Tick público para testes; soft-fail por workspace. */
  async tickDreamSchedules(): Promise<void> {
    if (this.stopping) {
      return;
    }
    for (const state of this.states.values()) {
      await this.maybeRunDream(state);
    }
  }

  /** Sincroniza o conjunto observado com o registry (add novos, remove sumidos). */
  private async reloadRegistry(): Promise<void> {
    const roots = new Set(listWorkspaceRoots().filter((root) => workspaceExists(root)));

    // Remove workspaces que saíram do registry.
    for (const [root, state] of this.states) {
      if (!roots.has(root)) {
        await this.teardownWorkspace(state);
        this.states.delete(root);
      }
    }

    // Adiciona novos.
    for (const root of roots) {
      if (!this.states.has(root)) {
        await this.setupWorkspace(root);
      }
    }
  }

  private async setupWorkspace(root: string): Promise<void> {
    const snapshotPath = snapshotPathFor(root);
    const state: WorkspaceState = {
      root,
      pipeline: new WorkspacePipeline(root, this.debounceMs, {
        onSync: (info) => {
          const s = this.states.get(info.root);
          if (s) {
            s.lastSyncAt = new Date().toISOString();
            s.lastSyncPaths = info.paths;
            s.lastSyncOk = info.ok;
            s.lastSyncDurationMs = info.durationMs;
            s.lastError = info.ok ? null : "sync retornou código não-zero";
          }
        },
        onError: (r, err) => {
          const s = this.states.get(r);
          if (s) {
            s.lastError = err.message;
          }
        },
      }, this.maxDebounceMs),
      subscription: null,
      snapshotPath,
      watching: false,
      resubscribeBackoffMs: 1_000,
      lastSyncAt: null,
      lastSyncPaths: 0,
      lastSyncOk: null,
      lastSyncDurationMs: null,
      lastEventAt: null,
      lastError: null,
      watchBackend: "off",
      pollTimer: null,
      lastDreamAt: null,
      lastDreamOk: null,
      lastDreamMode: null,
      lastDreamError: null,
      dreamScheduleEnabled: null,
      dreamRunning: false,
    };
    this.states.set(root, state);

    // Catch-up de downtime antes de subscrever (gap mínimo até o subscribe).
    try {
      if (existsSync(snapshotPath)) {
        const batch = await eventsSince(root, snapshotPath);
        const paths = [...batch.changed, ...batch.removed];
        if (paths.length > 0) {
          await state.pipeline.flushNow(paths);
        }
      } else if (hasDirtyPaths(root)) {
        // Sem snapshot, mas hooks git deixaram trabalho pendente: reconcilia.
        await runSync({ cwd: root });
      }
    } catch (err) {
      state.lastError = err instanceof Error ? err.message : String(err);
    }

    if (this.enableWatchers) {
      await this.subscribe(state);
    }
  }

  private async subscribe(state: WorkspaceState): Promise<void> {
    try {
      state.subscription = await subscribeWorkspace(
        state.root,
        (batch) => {
          state.lastEventAt = new Date().toISOString();
          state.pipeline.enqueue([...batch.changed, ...batch.removed]);
        },
        (err) => this.onWatcherError(state, err),
      );
      this.stopPolling(state);
      state.watching = true;
      state.watchBackend = "parcel-watcher";
      state.resubscribeBackoffMs = 1_000;
      await writeWatchSnapshot(state.root, state.snapshotPath);
    } catch (err) {
      this.onWatcherError(state, err instanceof Error ? err : new Error(String(err)));
    }
  }

  /** Backend caiu: agenda resubscribe com backoff exponencial limitado. */
  private onWatcherError(state: WorkspaceState, err: Error): void {
    state.watching = false;
    state.watchBackend = "poll";
    const exhaustion = watcherExhaustionHint(err);
    state.lastError = exhaustion ?? err.message;
    if (this.stopping) {
      return;
    }
    this.startPolling(state);
    // Exaustão é limite do SO, não transitório: vai direto ao backoff máximo para
    // não martelar o subscribe enquanto o polling cobre as mudanças.
    const delay = exhaustion ? MAX_RESUBSCRIBE_BACKOFF_MS : state.resubscribeBackoffMs;
    state.resubscribeBackoffMs = Math.min(delay * 2, MAX_RESUBSCRIBE_BACKOFF_MS);
    setTimeout(() => {
      if (!this.stopping && this.states.has(state.root)) {
        void this.subscribe(state);
      }
    }, delay);
  }

  private startPolling(state: WorkspaceState): void {
    if (state.pollTimer) {
      return;
    }
    state.pollTimer = setInterval(() => {
      void this.pollWorkspace(state);
    }, POLL_INTERVAL_MS);
    void this.pollWorkspace(state);
  }

  private stopPolling(state: WorkspaceState): void {
    if (state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
  }

  private async pollWorkspace(state: WorkspaceState): Promise<void> {
    const startedAt = Date.now();
    const code = await runSync({ cwd: state.root });
    state.lastSyncAt = new Date().toISOString();
    state.lastSyncPaths = 0;
    state.lastSyncOk = code === 0;
    state.lastSyncDurationMs = Date.now() - startedAt;
    if (code === 0) {
      state.lastError = null;
    } else {
      state.lastError = `poll sync retornou código ${code}`;
    }
  }

  private async teardownWorkspace(state: WorkspaceState): Promise<void> {
    state.pipeline.dispose();
    this.stopPolling(state);
    if (state.subscription) {
      try {
        await state.subscription.unsubscribe();
      } catch {
        /* já desinscrito */
      }
      state.subscription = null;
    }
  }

  private async refreshSnapshots(): Promise<void> {
    for (const state of this.states.values()) {
      if (state.watching) {
        try {
          await writeWatchSnapshot(state.root, state.snapshotPath);
        } catch {
          /* snapshot best-effort */
        }
      }
    }
  }

  private async maybeRunDream(state: WorkspaceState): Promise<void> {
    const config = loadMemoryConfig(state.root);
    const schedule = resolveDreamSchedule(config);
    state.dreamScheduleEnabled = schedule.enabled;

    if (!schedule.enabled) {
      return;
    }

    const vaultDir = getVaultDir(state.root);
    if (!existsSync(vaultDir)) {
      // Sprint §7.2 vazio / EVAL-003: skip silencioso — não marca last_dream_ok=false.
      return;
    }

    if (state.dreamRunning) {
      return;
    }

    if (state.lastDreamAt) {
      const elapsed = this.nowFn() - Date.parse(state.lastDreamAt);
      if (Number.isFinite(elapsed) && elapsed < schedule.intervalMs) {
        return;
      }
    }

    state.dreamRunning = true;
    const mode: DreamRunMode = schedule.dryRun ? "dry-run" : "apply";
    try {
      console.error(
        JSON.stringify({
          event: "dream_schedule_start",
          root: state.root,
          mode,
          interval_ms: schedule.intervalMs,
        }),
      );
      const result = await this.dreamRunner(state.root, { dryRun: schedule.dryRun });
      const vaultMissing =
        typeof result.message === "string" && result.message.includes("E_VAULT_NOT_FOUND");
      if (vaultMissing) {
        // Prefer skip prévio; se ainda assim voltar falha de vault, não contar como erro.
        console.error(
          JSON.stringify({
            event: "dream_schedule_skip",
            root: state.root,
            reason: "vault_missing",
          }),
        );
        return;
      }
      state.lastDreamAt = new Date(this.nowFn()).toISOString();
      state.lastDreamMode = mode;
      state.lastDreamOk = result.state !== "falha";
      state.lastDreamError = state.lastDreamOk
        ? null
        : (typeof result.message === "string" ? result.message : "dream falhou");
      console.error(
        JSON.stringify({
          event: "dream_schedule_done",
          root: state.root,
          mode,
          ok: state.lastDreamOk,
          state: result.state,
        }),
      );
    } catch (err) {
      // Soft-fail: loga e segue; sync/watch intactos (Sprint §7 D7 / EVAL-002).
      state.lastDreamAt = new Date(this.nowFn()).toISOString();
      state.lastDreamMode = mode;
      state.lastDreamOk = false;
      state.lastDreamError = err instanceof Error ? err.message : String(err);
      console.error(
        JSON.stringify({
          event: "dream_schedule_error",
          root: state.root,
          mode,
          error: state.lastDreamError,
        }),
      );
    } finally {
      state.dreamRunning = false;
      this.writeStatus();
    }
  }

  private buildStatusSnapshot(): DaemonStatusSnapshot {
    return {
      pid: process.pid,
      started_at: this.startedAt,
      updated_at: new Date().toISOString(),
      workspaces: [...this.states.values()].map((s) => ({
        root: s.root,
        watching: s.watching,
        last_sync_at: s.lastSyncAt,
        last_sync_paths: s.lastSyncPaths,
        last_sync_ok: s.lastSyncOk,
        last_sync_duration_ms: s.lastSyncDurationMs,
        last_event_at: s.lastEventAt,
        last_error: s.lastError,
        watch_backend: s.watchBackend,
        last_dream_at: s.lastDreamAt,
        last_dream_ok: s.lastDreamOk,
        last_dream_mode: s.lastDreamMode,
        last_dream_error: s.lastDreamError,
        dream_schedule_enabled: s.dreamScheduleEnabled,
      })),
    };
  }

  private writeStatus(): void {
    const snapshot = this.buildStatusSnapshot();
    try {
      writeFileAtomic(daemonStatusPath(), JSON.stringify(snapshot, null, 2) + "\n");
    } catch {
      /* status best-effort */
    }
  }

  async stop(code: number): Promise<void> {
    if (this.stopping) {
      return;
    }
    this.stopping = true;
    if (this.statusTimer) {
      clearInterval(this.statusTimer);
      this.statusTimer = null;
    }
    if (this.snapshotTimer) {
      clearInterval(this.snapshotTimer);
      this.snapshotTimer = null;
    }
    if (this.dreamTimer) {
      clearInterval(this.dreamTimer);
      this.dreamTimer = null;
    }
    for (const state of this.states.values()) {
      await this.refreshOne(state);
      await this.teardownWorkspace(state);
    }
    rmSync(daemonPidPath(), { force: true });
    this.writeStatus();
    if (this.daemonLockRelease) {
      this.daemonLockRelease();
      this.daemonLockRelease = null;
    }
    if (this.exitProcessOnStop) {
      process.exit(code);
    }
  }

  private async refreshOne(state: WorkspaceState): Promise<void> {
    if (state.watching) {
      try {
        await writeWatchSnapshot(state.root, state.snapshotPath);
      } catch {
        /* best-effort */
      }
    }
  }
}

/** Roda o daemon em foreground (bloqueia até sinal de término). */
export async function runDaemonForeground(options: DaemonRuntimeOptions = {}): Promise<boolean> {
  const runtime = new DaemonRuntime(options);
  if (!(await runtime.start())) {
    return false;
  }
  // Mantém o processo vivo: timers + subscriptions seguram o event loop.
  await new Promise<void>(() => {
    /* resolve nunca — encerramento é via process.exit nos handlers de sinal */
  });
  return true;
}
