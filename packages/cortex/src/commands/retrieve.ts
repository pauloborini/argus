import { buildToolStub } from "../mcp/tools/stubs.js";

export function runRetrieve(handle: string): number {
  try {
    const payload = buildToolStub("retrieve", process.cwd(), { handle });
    console.log(JSON.stringify(payload, null, 2));
    return payload.state === "falha" ? 1 : 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(message);
    return 1;
  }
}
