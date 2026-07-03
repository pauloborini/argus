import { dirname, delimiter, resolve } from "node:path";
import { listWorkspaceRoots } from "../daemon/registry.js";
import { readWorkspaceMetadata } from "./workspace.js";

/** Env explícita — prioridade máxima; usada em configs MCP locais do install. */
export const ARGUS_WORKSPACE_ROOT_ENV = "ARGUS_WORKSPACE_ROOT";

/** Env vars que hosts MCP costumam injetar com a raiz do projeto aberto. */
const HOST_WORKSPACE_ENV_KEYS = [
  ARGUS_WORKSPACE_ROOT_ENV,
  "CURSOR_CWD",
  "ZCODE_PROJECT_DIR",
  "CLAUDE_PROJECT_DIR",
  "CLAUDE_CODE_PROJECT_DIR",
] as const;

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
 * Resolve a raiz do workspace Argus para `serve --mcp` quando o host não
 * garante `process.cwd()` no projeto (configs MCP globais, spawn em pasta
 * interna do IDE, etc.).
 *
 * Ordem de candidatos (primeiro com `.argus/workspace.json` válido vence):
 * env explícita do host → `WORKSPACE_FOLDER_PATHS` → ancestrais do cwd →
 * registry do daemon.
 */
export function resolveServeWorkspaceRoot(
  startCwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): string | null {
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

  const seen = new Set<string>();
  for (const raw of candidates) {
    const root = resolve(raw);
    if (seen.has(root)) {
      continue;
    }
    seen.add(root);
    if (readWorkspaceMetadata(root)) {
      return root;
    }
  }

  return null;
}
