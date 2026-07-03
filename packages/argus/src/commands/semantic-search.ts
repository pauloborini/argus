import { buildToolResponseAsync } from "../mcp/tools/response.js";
import { serializePayload } from "../output.js";

export async function runSemanticSearch(
  query: string,
  options?: { mode?: "dense" | "hybrid"; domain?: "code" | "memory" | "all"; scope?: string; kind?: string; limit?: number },
): Promise<number> {
  try {
    const payload = await buildToolResponseAsync("semantic_search", process.cwd(), {
      query,
      mode: options?.mode,
      domain: options?.domain,
      scope: options?.scope,
      kind: options?.kind,
      limit: options?.limit,
    });
    console.log(serializePayload(payload));
    return payload.state === "falha" ? 1 : 0;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}
