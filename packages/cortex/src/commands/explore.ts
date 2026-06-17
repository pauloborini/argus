import { buildToolResponse } from "../mcp/tools/response.js";
import { serializePayload } from "../output.js";

export function runExplore(
  target: string,
  options?: { mode?: string; depth?: number; includeTests?: boolean; budget?: number },
): number {
  try {
    const payload = buildToolResponse("explore", process.cwd(), {
      target,
      mode: options?.mode,
      depth: options?.depth,
      include_tests: options?.includeTests,
      budget: options?.budget,
    });
    console.log(serializePayload(payload));
    return payload.state === "falha" ? 1 : 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(message);
    return 1;
  }
}
