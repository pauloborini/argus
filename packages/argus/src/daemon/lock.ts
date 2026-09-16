import { execFileSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { daemonLockPath } from "../workspace/user-paths.js";

const DEFAULT_DAEMON_LOCK_TIMEOUT_MS = 1_000;
const STALE_DAEMON_LOCK_MS = 60_000;

export interface DaemonLockRecord {
  pid: number;
  acquired_at: number;
  start_ms?: number;
}

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Lê o momento de inicialização de um processo em milissegundos desde a época.
 * Suporta Linux (/proc/<pid>/stat) e macOS (ps -o lstart=).
 * Retorna null quando a plataforma não permitir a leitura ou se o processo não existir.
 */
export function readProcessStartMs(pid: number): number | null {
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
      const lastParen = stat.lastIndexOf(")");
      if (lastParen === -1) {
        return null;
      }
      const tokens = stat.slice(lastParen + 1).trim().split(/\s+/);
      // Campo 22 (starttime) na /proc/<pid>/stat: índice 19 relativo ao fim de (comm)
      const jiffies = Number(tokens[19]);
      // CLK_TCK fixo em 100 (Linux genérico); precisão de segundos basta para distinguir processos
      return Number.isFinite(jiffies) ? jiffies * 10 : null;
    } catch {
      return null;
    }
  }

  if (process.platform === "darwin") {
    try {
      const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
        encoding: "utf-8",
        timeout: 2000,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      const parsed = Date.parse(out);
      return Number.isNaN(parsed) ? null : parsed;
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Compara se o lock ainda pertence ao mesmo processo (detecção de PID-reuse).
 * Record legado (sem start_ms) preserva a checagem anterior por liveness.
 */
export function isSameProcess(pid: number, startMs?: number): boolean {
  if (!isProcessAlive(pid)) {
    return false;
  }
  if (startMs === undefined) {
    return true; // record legado sem start_ms: preserva comportamento anterior
  }
  const currentStart = readProcessStartMs(pid);
  if (currentStart === null) {
    return true; // fallback seguro onde start_ms não pode ser lido pelo SO
  }
  return currentStart === startMs;
}

function daemonLockAgeMs(path: string): number {
  try {
    return Date.now() - statSync(path).mtimeMs;
  } catch {
    return Infinity;
  }
}

function tryStealStaleDaemonLock(path: string): void {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return;
  }

  try {
    const record = JSON.parse(raw) as DaemonLockRecord;
    if (!Number.isInteger(record.pid) || !isSameProcess(record.pid, record.start_ms)) {
      rmSync(path, { force: true });
    }
  } catch {
    if (daemonLockAgeMs(path) > STALE_DAEMON_LOCK_MS) {
      rmSync(path, { force: true });
    }
  }
}

/** Lock global do daemon: no máximo um runtime por usuário/estado XDG. */
export function acquireDaemonLock(timeoutMs = DEFAULT_DAEMON_LOCK_TIMEOUT_MS): (() => void) | null {
  const path = daemonLockPath();
  const deadline = Date.now() + timeoutMs;
  mkdirSync(dirname(path), { recursive: true });

  while (Date.now() <= deadline) {
    let fd: number | null = null;
    try {
      fd = openSync(path, "wx");
      const startMs = readProcessStartMs(process.pid) ?? undefined;
      const record: DaemonLockRecord = {
        pid: process.pid,
        acquired_at: Date.now(),
        ...(startMs !== undefined ? { start_ms: startMs } : {}),
      };
      writeSync(fd, JSON.stringify(record));
      const ownedFd = fd;
      return () => {
        closeSync(ownedFd);
        rmSync(path, { force: true });
      };
    } catch {
      if (fd !== null) {
        closeSync(fd);
      }
      tryStealStaleDaemonLock(path);
      sleepMs(25);
    }
  }

  return null;
}
