import { buildToolResponse } from "../mcp/tools/response.js";
import { serializePayload } from "../output.js";
import { formatRepoStatusHuman } from "./format-status.js";

export interface StatusCommandOptions {
  path?: string;
  json?: boolean;
}

export function runStatus(pathOrOpts?: string | StatusCommandOptions): number {
  const opts: StatusCommandOptions =
    typeof pathOrOpts === "string" ? { path: pathOrOpts } : (pathOrOpts ?? {});
  const cwd = opts.path ?? process.cwd();

  try {
    const payload = buildToolResponse("status", cwd, { response_format: "detailed" });
    if (opts.json) {
      console.log(serializePayload(payload));
    } else {
      console.log(formatRepoStatusHuman(payload, cwd));
    }
    return payload.state === "falha" ? 1 : 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(message);
    return 1;
  }
}
