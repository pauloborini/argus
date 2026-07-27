import {
  ARGUS_WORKSPACE_ROOT_ENV,
  resolveWorkspaceRoot,
} from "./resolve-workspace.js";

export { ARGUS_WORKSPACE_ROOT_ENV };

/**
 * Resolve a raiz do workspace Argus para `serve --mcp` quando o host não
 * garante `process.cwd()` no projeto (configs MCP globais, spawn em pasta
 * interna do IDE, etc.).
 *
 * Wrapper fino sobre {@link resolveWorkspaceRoot}: mesma ordem de candidatos
 * (env → WORKSPACE_FOLDER_PATHS → walk-up → registry) e heal D4; retorna só
 * o `rootPath` canônico (ou `null`).
 */
export function resolveServeWorkspaceRoot(
  startCwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const handle = resolveWorkspaceRoot(startCwd, env);
  return handle?.rootPath ?? null;
}
