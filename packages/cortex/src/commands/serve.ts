import { startMcpServer } from "../mcp/server.js";
import { requireWorkspace } from "../workspace/workspace.js";

export function runServeMcp(): Promise<number> {
  try {
    requireWorkspace();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(message);
    return Promise.resolve(1);
  }

  return startMcpServer()
    .then(() => 0)
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Falha ao iniciar MCP: ${message}`);
      return 1;
    });
}
