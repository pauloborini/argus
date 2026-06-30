import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { getDirtyFlagPath } from "../workspace/workspace.js";

/** Sleep síncrono curto sem busy-wait (entre tentativas de lock). */
function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Lock de arquivo entre processos via `O_EXCL`. Serializa o read-modify-write da
 * dirty-flag entre hooks git concorrentes (post-merge + post-checkout no mesmo
 * `git pull`/rebase), evitando perda de `paths`/`since_ref`. Em timeout, executa
 * sem lock (degrada ao last-writer-wins anterior, nunca trava o hook).
 */
function withLock<T>(lockPath: string, fn: () => T): T {
  let fd: number | null = null;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      fd = openSync(lockPath, "wx");
      break;
    } catch {
      sleepMs(2);
    }
  }
  try {
    return fn();
  } finally {
    if (fd !== null) {
      closeSync(fd);
      try {
        rmSync(lockPath, { force: true });
      } catch {
        /* lock já removido */
      }
    }
  }
}

export const DIRTY_FLAG_SCHEMA_VERSION = "1";

export interface DirtyFlag {
  schema_version: string;
  /** Ref git anterior ao primeiro evento sujo, quando conhecido. */
  since_ref: string | null;
  /** Paths relativos acumulados como sujos. */
  paths: string[];
  /** Verdadeiro quando o delta git não pôde ser resolvido: força walk completo. */
  force_full: boolean;
  updated_at: string;
}

function emptyFlag(): DirtyFlag {
  return {
    schema_version: DIRTY_FLAG_SCHEMA_VERSION,
    since_ref: null,
    paths: [],
    force_full: false,
    updated_at: new Date().toISOString(),
  };
}

/**
 * Lê a dirty-flag. Retorna `null` se ausente; em caso de corrupção, descarta
 * silenciosamente (o pior caso degrada para walk completo, nunca para erro).
 */
export function readDirtyFlag(cwd: string = process.cwd()): DirtyFlag | null {
  const path = getDirtyFlagPath(cwd);
  if (!existsSync(path)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as DirtyFlag;
    if (parsed.schema_version !== DIRTY_FLAG_SCHEMA_VERSION || !Array.isArray(parsed.paths)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Acumula paths na dirty-flag de forma idempotente e atômica (write-temp +
 * rename). Dedup por path. Registra `since_ref` só na primeira marcação de um
 * ciclo (quando a flag ainda não existia).
 */
export function markDirty(
  paths: string[],
  options: { sinceRef?: string | null; cwd?: string; forceFull?: boolean } = {},
): DirtyFlag {
  const cwd = options.cwd ?? process.cwd();
  const path = getDirtyFlagPath(cwd);

  // Read-modify-write sob lock entre processos: garante que marcações
  // concorrentes não percam paths nem sobrescrevam `since_ref` uma da outra.
  return withLock(`${path}.lock`, () => {
    const current = readDirtyFlag(cwd) ?? emptyFlag();
    const wasEmpty = current.paths.length === 0 && !current.force_full;

    const merged = new Set(current.paths);
    for (const p of paths) {
      if (p.length > 0) {
        merged.add(p);
      }
    }

    const next: DirtyFlag = {
      schema_version: DIRTY_FLAG_SCHEMA_VERSION,
      since_ref:
        wasEmpty && options.sinceRef !== undefined ? options.sinceRef : current.since_ref,
      paths: [...merged].sort((a, b) => a.localeCompare(b)),
      force_full: current.force_full || options.forceFull === true,
      updated_at: new Date().toISOString(),
    };

    // Tmp único + rename atômico para a escrita; o lock acima serializa o RMW.
    const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", "utf-8");
    renameSync(tmp, path);
    return next;
  });
}

/** Remove a dirty-flag (após um sync que a consumiu). Idempotente. */
export function clearDirtyFlag(cwd: string = process.cwd()): void {
  const path = getDirtyFlagPath(cwd);
  try {
    rmSync(path, { force: true });
  } catch {
    /* já ausente ou sem permissão — não é fatal */
  }
}

/** Verdadeiro se há trabalho sujo pendente (paths acumulados ou walk forçado). */
export function hasDirtyPaths(cwd: string = process.cwd()): boolean {
  const flag = readDirtyFlag(cwd);
  return flag !== null && (flag.paths.length > 0 || flag.force_full);
}
