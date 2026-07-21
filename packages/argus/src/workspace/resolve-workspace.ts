import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, delimiter, resolve } from "node:path";
import { listWorkspaceRoots } from "../daemon/registry.js";
import {
  getMetadataPath,
  getWorkspacePath,
  readWorkspaceMetadata,
  type WorkspaceMetadata,
} from "./workspace.js";

/** Env explícita — prioridade máxima; usada em configs MCP locais do install. */
export const ARGUS_WORKSPACE_ROOT_ENV = "ARGUS_WORKSPACE_ROOT";

/** Warning estável emitido quando `root_path` diverge do diretório que contém `.argus/`. */
export const W_WORKSPACE_ROOT_HEALED = "W_WORKSPACE_ROOT_HEALED";

/** Env vars que hosts MCP costumam injetar com a raiz do projeto aberto. */
const HOST_WORKSPACE_ENV_KEYS = [
  ARGUS_WORKSPACE_ROOT_ENV,
  "CURSOR_CWD",
  "ZCODE_PROJECT_DIR",
  "CLAUDE_PROJECT_DIR",
  "CLAUDE_CODE_PROJECT_DIR",
] as const;

/**
 * Handle canônico pós-resolve (+ heal D4).
 * `rootPath` é o pai de `.argus/`; após heal, `metadata.root_path === rootPath`.
 */
export interface WorkspaceHandle {
  rootPath: string;
  stateDir: string;
  metadata: WorkspaceMetadata;
  /** True quando `workspace.json.root_path` foi reescrito para o realpath de S. */
  healed?: boolean;
  /** Código de warning estável quando `healed` é true. */
  healWarning?: typeof W_WORKSPACE_ROOT_HEALED;
}

function walkUpDirectories(start: string): string[] {
  const dirs: string[] = [];
  let current = resolve(start);
  while (true) {
    dirs.push(current);
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return dirs;
}

function appendWorkspaceFolderPaths(candidates: string[], raw: string | undefined): void {
  if (!raw?.trim()) {
    return;
  }
  for (const segment of raw.split(delimiter)) {
    const trimmed = segment.trim();
    if (trimmed) {
      candidates.push(trimmed);
    }
  }
}

/**
 * Coleta candidatos na ordem canônica (env → WORKSPACE_FOLDER_PATHS → walk-up → registry).
 * Shared por CLI/MCP/daemon; `resolveServeWorkspaceRoot` é wrapper fino.
 */
export function collectWorkspaceRootCandidates(
  startCwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const candidates: string[] = [];

  for (const key of HOST_WORKSPACE_ENV_KEYS) {
    const value = env[key];
    if (value?.trim()) {
      candidates.push(value.trim());
    }
  }

  appendWorkspaceFolderPaths(candidates, env.WORKSPACE_FOLDER_PATHS);
  candidates.push(...walkUpDirectories(startCwd));

  try {
    candidates.push(...listWorkspaceRoots());
  } catch {
    /* registry indisponível em alguns ambientes de teste */
  }

  return candidates;
}

function realpathOrResolve(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

function writeWorkspaceMetadata(rootPath: string, metadata: WorkspaceMetadata): void {
  writeFileSync(getMetadataPath(rootPath), JSON.stringify(metadata, null, 2) + "\n", "utf-8");
}

/**
 * Heal D4: se `.argus/workspace.json` está em `S` e `root_path ≠ realpath(S)`,
 * reescreve `root_path := realpath(S)` e emite warning estável.
 * Não apaga `.argus` no path antigo (D5).
 */
export function healRootPathIfNeeded(
  stateParent: string,
  metadata: WorkspaceMetadata,
): { metadata: WorkspaceMetadata; healed: boolean } {
  const rootPath = realpathOrResolve(stateParent);
  if (metadata.root_path === rootPath) {
    return { metadata, healed: false };
  }

  const healedMeta: WorkspaceMetadata = { ...metadata, root_path: rootPath };
  writeWorkspaceMetadata(rootPath, healedMeta);
  return { metadata: healedMeta, healed: true };
}

/**
 * Resolve a raiz canônica do workspace Argus.
 *
 * Ordem de candidatos (primeiro com `.argus/workspace.json` válido vence):
 * env explícita do host → `WORKSPACE_FOLDER_PATHS` → ancestrais do cwd →
 * registry do daemon. Após achar `S`, aplica heal D4.
 */
export function resolveWorkspaceRoot(
  startCwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): WorkspaceHandle | null {
  const seen = new Set<string>();

  for (const raw of collectWorkspaceRootCandidates(startCwd, env)) {
    const candidate = resolve(raw);
    if (seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);

    const metadataPath = getMetadataPath(candidate);
    const metadata = readWorkspaceMetadata(candidate);
    if (!metadata) {
      if (existsSync(metadataPath)) {
        throw new Error(
          `E_WORKSPACE_INVALID: Metadados corrompidos em ${metadataPath}. Repare workspace.json antes de continuar.`,
        );
      }
      continue;
    }

    const rootPath = realpathOrResolve(candidate);
    const { metadata: healedMeta, healed } = healRootPathIfNeeded(candidate, metadata);

    if (healed) {
      const msg = `${W_WORKSPACE_ROOT_HEALED}: root_path alinhado para ${rootPath} (antes: ${metadata.root_path}).`;
      process.stderr.write(`${msg}\n`);
    }

    return {
      rootPath,
      stateDir: getWorkspacePath(rootPath),
      metadata: healedMeta,
      ...(healed
        ? { healed: true as const, healWarning: W_WORKSPACE_ROOT_HEALED }
        : {}),
    };
  }

  return null;
}
