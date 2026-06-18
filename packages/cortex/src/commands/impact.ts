import { buildToolResponse } from "../mcp/tools/response.js";
import { serializePayload } from "../output.js";

export function runImpact(
  target: string,
  options?: { direction?: string; depth?: number; includeTests?: boolean; summaryOnly?: boolean },
): number {
  try {
    const payload = buildToolResponse("impact", process.cwd(), {
      target,
      direction: options?.direction,
      depth: options?.depth,
      include_tests: options?.includeTests,
      summary_only: options?.summaryOnly,
    });
    console.log(serializePayload(payload));
    return payload.state === "falha" ? 1 : 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(message);
    return 1;
  }
}
