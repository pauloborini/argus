// Compressão de payload em modo concise: remove campos derivados e aplica path dictionary.
import type { ToolResponsePayload } from "./common.js";
import type { McpToolName } from "../tool-registry.js";

// Remove campos que o consumidor pode derivar dos dados primários.
function stripDerivedFields(payload: ToolResponsePayload, tool: McpToolName): ToolResponsePayload {
  if (tool === "trace") {
    // files[] e symbols[] top-level duplicam paths[].hops; dentro do path object idem.
    const { files, symbols, paths, ...rest } = payload;
    void files;
    void symbols;
    const cleanPaths = Array.isArray(paths)
      ? paths.map((p: unknown) => {
          if (p && typeof p === "object" && !Array.isArray(p)) {
            const { files: pf, symbols: ps, ...hopRest } = p as Record<string, unknown>;
            void pf;
            void ps;
            return hopRest;
          }
          return p;
        })
      : paths;
    return { paths: cleanPaths, ...rest } as ToolResponsePayload;
  }
  if (tool === "impact") {
    // files[] e tests[] deriváveis de direct_affected + indirect_affected pelo consumidor.
    const { files, tests, ...rest } = payload;
    void files;
    void tests;
    return rest as ToolResponsePayload;
  }
  return payload;
}

function collectPathValues(obj: unknown, counts: Map<string, number>): void {
  if (!obj || typeof obj !== "object") return;
  if (Array.isArray(obj)) {
    for (const item of obj) collectPathValues(item, counts);
    return;
  }
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (k === "path" && typeof v === "string") {
      counts.set(v, (counts.get(v) ?? 0) + 1);
    } else {
      collectPathValues(v, counts);
    }
  }
}

function replacePathValues(obj: unknown, idx: Map<string, number>): unknown {
  if (!obj || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map((item) => replacePathValues(item, idx));
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (k === "path" && typeof v === "string") {
      const i = idx.get(v);
      result[k] = i !== undefined ? `$${i}` : v;
    } else {
      result[k] = replacePathValues(v, idx);
    }
  }
  return result;
}

// Substitui paths repetidos (≥2×) por `$N` e adiciona `_paths: string[]` no top-level.
function applyPathDictionary(payload: ToolResponsePayload): ToolResponsePayload {
  const counts = new Map<string, number>();
  collectPathValues(payload, counts);

  const repeated = Array.from(counts.entries())
    .filter(([, n]) => n >= 2)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([p]) => p);

  if (repeated.length < 2) return payload;

  const idx = new Map<string, number>(repeated.map((p, i) => [p, i]));
  const compressed = replacePathValues(payload, idx) as ToolResponsePayload;
  compressed._paths = repeated;
  return compressed;
}

export function compressPayload(payload: ToolResponsePayload, tool: McpToolName): ToolResponsePayload {
  return applyPathDictionary(stripDerivedFields(payload, tool));
}
