import { buildToolStub } from "../mcp/tools/stubs.js";
import { serializePayload } from "../output.js";

export function runPackContext(options: {
  sources?: string[];
  goal?: string;
  tokenBudget?: number;
  style?: string;
}): number {
  try {
    const payload = buildToolStub("pack_context", process.cwd(), {
      sources: options.sources,
      goal: options.goal,
      token_budget: options.tokenBudget,
      style: options.style,
    });
    console.log(serializePayload(payload));
    return payload.state === "falha" ? 1 : 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(message);
    return 1;
  }
}
