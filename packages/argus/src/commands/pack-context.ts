import { buildToolResponseAsync } from "../mcp/tools/response.js";
import { serializePayload } from "../output.js";

export async function runPackContext(options: {
  sources?: string[];
  goal?: string;
  tokenBudget?: number;
  style?: string;
  synthesize?: boolean;
}): Promise<number> {
  try {
    const payload = await buildToolResponseAsync("pack_context", process.cwd(), {
      sources: options.sources,
      goal: options.goal,
      token_budget: options.tokenBudget,
      style: options.style,
      synthesize: options.synthesize,
    });
    console.log(serializePayload(payload));
    return payload.state === "falha" ? 1 : 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(message);
    return 1;
  }
}
