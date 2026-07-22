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
  /** Path antigo de `root_path` antes do heal (para diagnóstico de sombra D5). */
  previousRootPath?: string;
}

export interface WorkspaceResolutionOptions {
  /** Registry é útil para bootstrap do MCP/daemon, mas proibido em tool calls fail-closed. */
  includeRegistry?: boolean;
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
  options: WorkspaceResolutionOptions = {},
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

  if (options.includeRegistry !== false) {
    try {
      candidates.push(...listWorkspaceRoots());
    } catch {
      /* registry indisponível em alguns ambientes de teste */
    }
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
 * Root de estado a partir do diretório que já contém `.argus` (sem walk-up — Plano 4).
 * Aplica heal D4. Retorna null se não houver metadata válida em `startCwd`.
 * Usado por sync/status/memória/handles no hot path local.
 */
export function resolveLocalStateRoot(startCwd: string): {
  rootPath: string;
  metadata: WorkspaceMetadata;
  healed: boolean;
} | null {
  const metadata = readWorkspaceMetadata(startCwd);
  if (!metadata) {
    return null;
  }
  const { metadata: healedMeta, healed } = healRootPathIfNeeded(startCwd, metadata);
  return {
    rootPath: healedMeta.root_path,
    metadata: healedMeta,
    healed,
  };
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
  options: WorkspaceResolutionOptions = {},
): WorkspaceHandle | null {
  const seen = new Set<string>();

  for (const raw of collectWorkspaceRootCandidates(startCwd, env, options)) {
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
        ? { healed: true as const, healWarning: W_WORKSPACE_ROOT_HEALED, previousRootPath: metadata.root_path }
        : {}),
    };
  }

  return null;
}

/**
 * Resolve + heal + fail-closed. Lança `E_WORKSPACE_INVALID` se nenhum
 * workspace válido for encontrado nos candidatos (env → walk-up → registry).
 *
 * Diferente de `requireWorkspace` (workspace.ts), faz walk-up a partir de
 * `startCwd` — subdiretórios de um repo com `.argus` na raiz resolvem
 * corretamente (Plano 4).
 */
export function requireWorkspaceRoot(
  startCwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): WorkspaceHandle {
  const handle = resolveWorkspaceRoot(startCwd, env);
  if (!handle) {
    throw new Error(
      "E_WORKSPACE_INVALID: Workspace não preparado ou path inválido. Execute argus init.",
    );
  }
  return handle;
}

/**
 * Resultado do diagnóstico de `.argus` sombra (D5).
 * `shadows` lista paths com `.argus/workspace.json` diferente do root canônico.
 */
export interface ShadowArgusState {
  /** Path canônico que contém o `.argus` ativo. */
  canonical: string;
  /** Paths absolutos de `.argus` sombra (diferentes do root canônico). */
  shadows: string[];
  /** Path do `.argus` sombra que era o `root_path` antes do heal (se aplicável). */
  previousRootShadow?: string;
}

/**
 * Diagnóstico de sombra D5: detecta `.argus` em paths diferentes do root
 * canônico. Nunca apaga — apenas reporta para o usuário decidir.
 *
 * Fontes de candidatos a sombra:
 * 1. `previousRootPath` do handle (antigo `root_path` antes do heal).
 * 2. Registry do daemon (roots registrados diferentes do canônico).
 */
export function findShadowArgusState(handle: WorkspaceHandle): ShadowArgusState {
  const shadows: string[] = [];
  const canonical = realpathOrResolve(handle.rootPath);
  const seen = new Set<string>([canonical]);

  // 1. Antigo root_path antes do heal
  if (handle.previousRootPath) {
    const previous = realpathOrResolve(handle.previousRootPath);
    if (!seen.has(previous)) {
      seen.add(previous);
      if (existsSync(getMetadataPath(previous))) {
        shadows.push(previous);
      }
    }
  }

  // 2. Registry do daemon
  try {
    for (const root of listWorkspaceRoots()) {
      const physicalRoot = realpathOrResolve(root);
      if (seen.has(physicalRoot)) {
        continue;
      }
      seen.add(physicalRoot);
      if (existsSync(getMetadataPath(physicalRoot))) {
        shadows.push(physicalRoot);
      }
    }
  } catch {
    /* registry indisponível */
  }

  const result: ShadowArgusState = { canonical, shadows };
  if (handle.previousRootPath) {
    const previous = realpathOrResolve(handle.previousRootPath);
    if (shadows.includes(previous)) {
      result.previousRootShadow = previous;
    }
  }
  return result;
}
