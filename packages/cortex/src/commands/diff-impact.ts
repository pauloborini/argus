import { buildToolStub } from "../mcp/tools/stubs.js";

export function runDiffImpact(options?: { scope?: string; baseRef?: string }): number {
  try {
    const payload = buildToolStub("diff_impact", process.cwd(), {
      scope: options?.scope,
      base_ref: options?.baseRef,
    });
    console.log(JSON.stringify(payload, null, 2));
    return payload.state === "falha" ? 1 : 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(message);
    return 1;
  }
}
