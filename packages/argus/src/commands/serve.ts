import { startMcpServer, type McpServerOptions } from "../mcp/server.js";
import { resolveServeWorkspaceRoot } from "../workspace/resolve-serve-root.js";
import { requireWorkspace } from "../workspace/workspace.js";

export function runServeMcp(options: McpServerOptions = {}): Promise<number> {
  const workspaceRoot = resolveServeWorkspaceRoot();
  if (!workspaceRoot) {
    console.error(
      "E_WORKSPACE_INVALID: Workspace não preparado ou path inválido. Execute argus init.",
    );
    return Promise.resolve(1);
  }

  try {
    process.chdir(workspaceRoot);
    requireWorkspace();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(message);
    return Promise.resolve(1);
  }

  return startMcpServer(options)
    .then(() => 0)
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Falha ao iniciar MCP: ${message}`);
      return 1;
    });
}
