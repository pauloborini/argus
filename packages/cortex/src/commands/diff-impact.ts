import { buildToolResponse } from "../mcp/tools/response.js";
import { serializePayload } from "../output.js";

export function runDiffImpact(options?: { scope?: string; baseRef?: string }): number {
  try {
    const payload = buildToolResponse("diff_impact", process.cwd(), {
      scope: options?.scope,
      base_ref: options?.baseRef,
    });
    console.log(serializePayload(payload));
    return payload.state === "falha" ? 1 : 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(message);
    return 1;
  }
}
