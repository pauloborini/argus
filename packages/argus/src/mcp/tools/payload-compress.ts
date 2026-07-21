// Compressão de payload em modo concise: remove campos derivados e aplica path dictionary.
// Campos acionáveis (snippets.body, origin_refs, retrieve_handle, códigos E_*) são preservados.
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
  // explore/pack: snippets, origin_refs, retrieve_handle e packed_context permanecem intactos.
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

/**
 * Remove campos com valor vazio (null, undefined, "", [], {}) de objetos aninhados.
 * Preserva `0` e `false`. Aplicado apenas dentro de objetos nestados (itens de
 * array, valores de objetos top-level) — nunca remove chaves do payload raiz,
 * que são campos de contrato da API.
 */
function elideEmptyFieldsInner(obj: unknown): unknown {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return obj;
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (v === null || v === undefined) continue;
    if (typeof v === "string" && v === "") continue;
    if (Array.isArray(v) && v.length === 0) continue;
    if (typeof v === "object" && !Array.isArray(v) && Object.keys(v as object).length === 0) continue;
    result[k] =
      Array.isArray(v)
        ? v.map((item) => elideEmptyFieldsInner(item))
        : typeof v === "object"
          ? elideEmptyFieldsInner(v)
          : v;
  }
  return result;
}

/**
 * Aplica elision apenas dentro dos valores do payload raiz (nunca remove chaves
 * top-level que fazem parte do contrato da API).
 */
function elideEmptyFields(payload: ToolResponsePayload): ToolResponsePayload {
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    result[k] = Array.isArray(v)
      ? v.map((item) => elideEmptyFieldsInner(item))
      : v !== null && typeof v === "object"
        ? elideEmptyFieldsInner(v)
        : v;
  }
  return result as ToolResponsePayload;
}

export function compressPayload(payload: ToolResponsePayload, tool: McpToolName): ToolResponsePayload {
  return elideEmptyFields(applyPathDictionary(stripDerivedFields(payload, tool)));
}
