import { buildToolResponse, buildToolResponseTsv } from "../mcp/tools/response.js";
import { serializePayload } from "../output.js";

export function runSearch(
  query: string,
  options?: { scope?: string; kind?: string; limit?: number; format?: string },
): number {
  try {
    if (options?.format === "tsv") {
      const { text, truncationNote, isError } = buildToolResponseTsv("search", process.cwd(), {
        query,
        scope: options.scope,
        kind: options.kind,
        limit: options.limit,
      });
      process.stdout.write(text + "\n");
      if (truncationNote) {
        process.stderr.write(`# ${truncationNote}\n`);
      }
      return isError ? 1 : 0;
    }
    const payload = buildToolResponse("search", process.cwd(), {
      query,
      scope: options?.scope,
      kind: options?.kind,
      limit: options?.limit,
    });
    console.log(serializePayload(payload));
    return payload.state === "falha" ? 1 : 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(message);
    return 1;
  }
}
