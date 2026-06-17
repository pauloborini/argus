import { buildToolResponse } from "../mcp/tools/response.js";
import { serializePayload } from "../output.js";

export function runFiles(options?: { pattern?: string; maxDepth?: number }): number {
  try {
    const payload = buildToolResponse("files", process.cwd(), {
      pattern: options?.pattern,
      max_depth: options?.maxDepth,
    });
    console.log(serializePayload(payload));
    return payload.state === "falha" ? 1 : 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(message);
    return 1;
  }
}
