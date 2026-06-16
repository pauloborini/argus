import { buildToolStub } from "../mcp/tools/stubs.js";
import { serializePayload } from "../output.js";

export function runTrace(
  from: string,
  options?: { to?: string; direction?: string; maxHops?: number },
): number {
  try {
    const payload = buildToolStub("trace", process.cwd(), {
      from,
      to: options?.to,
      direction: options?.direction,
      max_hops: options?.maxHops,
    });
    console.log(serializePayload(payload));
    return payload.state === "falha" ? 1 : 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(message);
    return 1;
  }
}
