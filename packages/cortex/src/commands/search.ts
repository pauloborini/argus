import { buildToolResponse } from "../mcp/tools/response.js";
import { serializePayload } from "../output.js";

export function runSearch(
  query: string,
  options?: { scope?: string; kind?: string; limit?: number },
): number {
  try {
    const payload = buildToolResponse("search", process.cwd(), {
      query,
      scope: options?.scope,
      kind: options?.kind,
      limit: options?.limit,
    });
    console.log(serializePayload(payload));
    return payload.state === "falha" ? 1 : 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(message);
    return 1;
  }
}
