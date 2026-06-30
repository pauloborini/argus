import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { daemonLockPath } from "../workspace/user-paths.js";

const DEFAULT_DAEMON_LOCK_TIMEOUT_MS = 1_000;
const STALE_DAEMON_LOCK_MS = 60_000;

interface DaemonLockRecord {
  pid: number;
  acquired_at: number;
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
    if (!Number.isInteger(record.pid) || !isProcessAlive(record.pid)) {
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
      const record: DaemonLockRecord = { pid: process.pid, acquired_at: Date.now() };
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
