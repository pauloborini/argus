import { buildToolResponse } from "../mcp/tools/response.js";
import { serializePayload } from "../output.js";

export function runRetrieve(handle: string): number {
  try {
    const payload = buildToolResponse("retrieve", process.cwd(), { handle });
    console.log(serializePayload(payload));
    return payload.state === "falha" ? 1 : 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(message);
    return 1;
  }
}
