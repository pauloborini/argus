import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { registryPath, userConfigDir } from "../workspace/user-paths.js";

export const REGISTRY_SCHEMA_VERSION = "1";

/** Sleep síncrono curto sem busy-wait (entre tentativas de lock). */
function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Lock de arquivo entre processos via `O_EXCL`, serializando o read-modify-write
 * do registry entre `argus install`/`uninstall` concorrentes (evita lost-update
 * de workspaces). Em timeout, executa sem lock (degrada ao last-writer-wins,
 * nunca trava o comando).
 */
function withRegistryLock<T>(fn: () => T): T {
  const lockPath = `${registryPath()}.lock`;
  mkdirSync(dirname(lockPath), { recursive: true });
  let fd: number | null = null;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      fd = openSync(lockPath, "wx");
      break;
    } catch {
      sleepMs(4);
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

export interface RegisteredWorkspace {
  /** Raiz absoluta do repo (onde vive o `.argus/`). */
  root: string;
  registered_at: string;
}

export interface WorkspaceRegistry {
  schema_version: string;
  workspaces: RegisteredWorkspace[];
}

function emptyRegistry(): WorkspaceRegistry {
  return { schema_version: REGISTRY_SCHEMA_VERSION, workspaces: [] };
}

/**
 * Lê o registry de workspaces observados. Ausente ou corrompido → registry
 * vazio (degrada honesto: o daemon simplesmente não observa nada até um
 * `argus install` re-registrar).
 */
export function readRegistry(): WorkspaceRegistry {
  const path = registryPath();
  if (!existsSync(path)) {
    return emptyRegistry();
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as WorkspaceRegistry;
    if (parsed.schema_version !== REGISTRY_SCHEMA_VERSION || !Array.isArray(parsed.workspaces)) {
      return emptyRegistry();
    }
    return parsed;
  } catch {
    return emptyRegistry();
  }
}

function writeRegistry(registry: WorkspaceRegistry): void {
  const path = registryPath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(registry, null, 2) + "\n", "utf-8");
  renameSync(tmp, path);
}

/**
 * Registra um workspace (idempotente por `root` absoluto). Retorna `true` se
 * adicionou, `false` se já estava registrado.
 */
export function registerWorkspace(root: string): boolean {
  const abs = resolve(root);
  return withRegistryLock(() => {
    const registry = readRegistry();
    if (registry.workspaces.some((ws) => ws.root === abs)) {
      return false;
    }
    registry.workspaces.push({ root: abs, registered_at: new Date().toISOString() });
    writeRegistry(registry);
    return true;
  });
}

/** Remove um workspace do registry. Retorna `true` se removeu. */
export function unregisterWorkspace(root: string): boolean {
  const abs = resolve(root);
  return withRegistryLock(() => {
    const registry = readRegistry();
    const next = registry.workspaces.filter((ws) => ws.root !== abs);
    if (next.length === registry.workspaces.length) {
      return false;
    }
    writeRegistry({ ...registry, workspaces: next });
    return true;
  });
}

/** Lista as raízes absolutas registradas. */
export function listWorkspaceRoots(): string[] {
  return readRegistry().workspaces.map((ws) => ws.root);
}

/** Garante a existência do diretório de config (usado por testes e setup). */
export function ensureConfigDir(): void {
  mkdirSync(userConfigDir(), { recursive: true });
}
