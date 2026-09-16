// Dispatcher das tools + formatação de envelope (concise/detailed).
import { stubResponse } from "../../contracts/response-state.js";
import { STRUCTURAL_INDEX_SCHEMA_VERSION } from "../../extraction/types.js";
import { SQLITE_SCHEMA_VERSION } from "../../storage/sqlite-prepared.js";
import { readWorkspaceMetadata } from "../../workspace/workspace.js";
import { resolveWorkspaceRoot } from "../../workspace/resolve-workspace.js";
import type { McpToolName } from "../tool-registry.js";
import { WORKSPACE_MISSING, buildIndexEnvelope, isWithinPath } from "./common.js";
import type { ToolResponsePayload, SearchArgs, FilesArgs, ExploreArgs, TraceArgs, ImpactArgs, DiffImpactArgs, PackContextArgs, PackOriginRef, PackRemovedEntry, RetrieveArgs, StructuralLoadMode } from "./common.js";
import { buildStatusResponse } from "./status.js";
import { buildFilesResponse, applyFilesFilters, readFilesForTsv } from "./files.js";
import { buildSearchResponse } from "./search.js";
import { buildSemanticSearchDegraded, buildSemanticSearchResponse } from "./semantic-search.js";
import type { SemanticSearchArgs, SemanticSearchDeps } from "./semantic-search.js";
import { buildTraceResponse } from "./trace.js";
import { buildImpactResponse } from "./impact.js";
import { buildRetrieveResponse, buildPackContextResponse } from "./pack.js";
import { buildDiffImpactResponse } from "./diff-impact.js";
import { buildExploreResponse } from "./explore.js";
import { buildRememberResponse, type RememberArgs } from "./remember.js";
import { buildRecallResponse, buildRecallResponseAsync, type RecallArgs } from "./recall.js";
import { compressPayload } from "./payload-compress.js";
import { ThinkEngine } from "../../memory/think-engine.js";
import { countTokens } from "../../packing/tokenizer.js";

/** Respostas honestas por tool — campos vazios alinhados a SURFACE_MCP_CLI.md (S02) */
type ResponseFormat = "concise" | "detailed";

// Default conciso: o envelope de honestidade (confidence/message/limitations em
// prosa pt-br) custa ~50-70% dos tokens de envelope e quase tudo é derivável de
// `state` ou de um código `E_*`. `detailed` restaura a prosa completa.
let defaultResponseFormat: ResponseFormat = "concise";

export function setDefaultResponseFormat(format: ResponseFormat): void {
  defaultResponseFormat = format;
}

function resolveResponseFormat(args?: Record<string, unknown>): ResponseFormat {
  const raw = args?.response_format;
  return raw === "detailed" || raw === "concise" ? raw : defaultResponseFormat;
}

// Extrai o código de sinal (`E_…` / `W_…`) de uma string de envelope, descartando
// a prosa que vem depois de `: `. Retorna `undefined` quando não há código.
const ENVELOPE_CODE = /^([EW]_[A-Z0-9_]+)\b/;

function envelopeCode(text: string | undefined): string | undefined {
  if (!text) {
    return undefined;
  }
  const match = ENVELOPE_CODE.exec(text);
  return match ? match[1] : undefined;
}

/**
 * Pós-processa o envelope para o formato pedido. Em `concise` (default) o
 * envelope cai ao sinal mínimo acionável (INV-H4 / D6):
 *  - `confidence` dropado (100% derivável de `state`);
 *  - `message` mantém só o código `E_*`/`W_*`; prosa estática (sucesso) some;
 *  - `limitations` cosméticas saem; códigos `E_*`/`W_*` sobrevivem compactos;
 *  - `staleness_hint` (prosa pt-br) sai — `state` + códigos cobrem o sinal;
 *  - domínio acionável permanece: `embedding_status`, `retrieve_handle`,
 *    `origin_refs`, snippets, candidates, hops, tree, …
 * `detailed` restaura a prosa completa.
 */
export function applyResponseFormat(
  payload: ToolResponsePayload,
  format: ResponseFormat,
  tool: McpToolName,
): ToolResponsePayload {
  if (format === "detailed") {
    return payload;
  }

  const { message, confidence, limitations, staleness_hint, ...rest } = payload;
  void confidence;
  void staleness_hint;
  const out = rest as ToolResponsePayload;

  const messageCode = envelopeCode(typeof message === "string" ? message : undefined);
  if (messageCode) {
    out.message = messageCode;
  }

  // Whitelist: só códigos E_*/W_* em limitations; prosa cosmética some.
  if (Array.isArray(limitations) && limitations.length > 0) {
    const codes: string[] = [];
    const seen = new Set<string>();
    for (const item of limitations) {
      const code = envelopeCode(typeof item === "string" ? item : undefined);
      if (code && !seen.has(code)) {
        seen.add(code);
        codes.push(code);
      }
    }
    if (codes.length > 0) {
      out.limitations = codes;
    }
  }

  return compressPayload(out, tool);
}

export function buildToolResponse(
  tool: McpToolName,
  cwd: string = process.cwd(),
  args?: Record<string, unknown>,
): ToolResponsePayload {
  const pathFailure = tool === "status" ? validateStatusPath(cwd) : null;
  if (pathFailure) {
    return applyResponseFormat(pathFailure, resolveResponseFormat(args), tool);
  }
  const rootCwd = resolveWorkspaceRoot(cwd, process.env, { includeRegistry: false })?.rootPath ?? cwd;
  return applyResponseFormat(
    buildToolResponseInner(tool, rootCwd, args),
    resolveResponseFormat(args),
    tool,
  );
}

function statusPathFailure(): ToolResponsePayload {
  return {
    initialized: false,
    staleness: "unknown",
    pending_files_count: 0,
    coverage_by_language: {},
    ...stubResponse(
      "falha",
      "E_PATH_OUTSIDE_WORKSPACE: `path` precisa permanecer no workspace atual.",
    ),
  };
}

/** Mantém o boundary de `status --path`, inclusive com shell em subdiretório. */
function validateStatusPath(cwd: string): ToolResponsePayload | null {
  if (isWithinPath(process.cwd(), cwd)) {
    return null;
  }
  const current = resolveWorkspaceRoot(process.cwd(), process.env, { includeRegistry: false });
  const requested = resolveWorkspaceRoot(cwd, process.env, { includeRegistry: false });
  return current && requested && current.rootPath === requested.rootPath
    ? null
    : statusPathFailure();
}

function buildToolResponseInner(
  tool: McpToolName,
  cwd: string = process.cwd(),
  args?: Record<string, unknown>,
): ToolResponsePayload {
  if (!readWorkspaceMetadata(cwd) && tool !== "status") {
    return {
      ...stubResponse("falha", WORKSPACE_MISSING),
    };
  }

  // Tools quentes usam meta-only + SQL/LazyTraceGraph por alvo. Full-load só
  // permanece para caminhos que ainda materializam o grafo inteiro (nenhum no
  // path feliz explore/pack/diff/retrieve/status).
  const needsIndex =
    tool !== "retrieve" &&
    tool !== "status" &&
    tool !== "remember" &&
    tool !== "recall";

  if (!needsIndex) {
    switch (tool) {
      case "retrieve":
        return buildRetrieveResponse(cwd, args as RetrieveArgs | undefined);
      case "status":
        return buildStatusResponse(cwd);
      case "remember":
        throw new Error(
          "remember exige buildToolResponseAsync (hot embed assíncrono).",
        );
      case "recall":
        return buildRecallResponse(cwd, args as RecallArgs | undefined);
    }
  }

  const mode: StructuralLoadMode =
    tool === "search" ||
    tool === "files" ||
    tool === "trace" ||
    tool === "impact" ||
    tool === "semantic_search" ||
    tool === "explore" ||
    tool === "pack_context" ||
    tool === "diff_impact"
      ? "lite"
      : "full";
  const envelope = buildIndexEnvelope(cwd, mode);

  switch (tool) {
    case "search":
      return buildSearchResponse(cwd, envelope, args as SearchArgs | undefined);
    case "explore":
      return buildExploreResponse(cwd, envelope, args as ExploreArgs | undefined);
    case "trace":
      return buildTraceResponse(cwd, envelope, args as TraceArgs | undefined);
    case "impact":
      return buildImpactResponse(cwd, envelope, args as ImpactArgs | undefined);
    case "diff_impact":
      return buildDiffImpactResponse(cwd, envelope, args as DiffImpactArgs | undefined);
    case "files":
      {
        const payload = buildFilesResponse(cwd, envelope);
        if (Array.isArray(payload.tree)) {
          payload.tree = applyFilesFilters(
            payload.tree as Array<{ path: string; symbol_counts?: unknown }>,
            args as FilesArgs | undefined,
          );
        }
        return payload;
      }
    case "pack_context":
      return buildPackContextResponse(cwd, envelope, args as PackContextArgs | undefined);
    case "semantic_search":
      // Caminho síncrono: degrada para fallback lexical (sem embeddar a query).
      // A busca densa real exige embed assíncrono → buildToolResponseAsync.
      return buildSemanticSearchDegraded(cwd, envelope, args as SemanticSearchArgs | undefined);
  }
}

/**
 * Variante assíncrona do dispatcher. `semantic_search`, `remember` (hot embed) e
 * `recall` híbrido precisam de await; as demais tools delegam ao caminho síncrono.
 * Usada pelo servidor MCP e pelo comando CLI `semantic-search`.
 */
export async function buildToolResponseAsync(
  tool: McpToolName,
  cwd: string = process.cwd(),
  args?: Record<string, unknown>,
  deps?: SemanticSearchDeps,
): Promise<ToolResponsePayload> {
  const rootCwd = resolveWorkspaceRoot(cwd, process.env, { includeRegistry: false })?.rootPath ?? cwd;
  // Mantém o mesmo fail-closed do dispatcher síncrono. Sem workspace válido,
  // caminhos async não podem criar memória/handles órfãos no cwd.
  if (!readWorkspaceMetadata(rootCwd) && tool !== "status") {
    return applyResponseFormat(
      { ...stubResponse("falha", WORKSPACE_MISSING) },
      resolveResponseFormat(args),
      tool,
    );
  }
  if (tool === "semantic_search") {
    const domain = (args as SemanticSearchArgs | undefined)?.domain;
    if (!readWorkspaceMetadata(rootCwd) && domain !== "memory") {
      return applyResponseFormat(
        buildToolResponseInner(tool, rootCwd, args),
        resolveResponseFormat(args),
        tool,
      );
    }
    const envelope = buildIndexEnvelope(rootCwd, "lite");
    const inner = await buildSemanticSearchResponse(
      rootCwd,
      envelope,
      args as SemanticSearchArgs | undefined,
      deps,
    );
    return applyResponseFormat(inner, resolveResponseFormat(args), tool);
  }
  if (tool === "remember") {
    return applyResponseFormat(
      await buildRememberResponse(rootCwd, args as RememberArgs | undefined, deps?.embedder),
      resolveResponseFormat(args),
      tool,
    );
  }
  if (tool === "recall") {
    return applyResponseFormat(
      await buildRecallResponseAsync(rootCwd, args as RecallArgs | undefined, deps?.embedder),
      resolveResponseFormat(args),
      tool,
    );
  }
  if (tool === "pack_context" && (args as PackContextArgs | undefined)?.synthesize === true) {
    const envelope = buildIndexEnvelope(rootCwd, "lite");
    const pack = buildPackContextResponse(rootCwd, envelope, args as PackContextArgs | undefined);
    if (pack.state !== "falha" && typeof pack.packed_context === "string") {
      pack.synthesis = await ThinkEngine.think(String((args as PackContextArgs | undefined)?.goal ?? ""), {
        context: pack.packed_context,
        cwd: rootCwd,
        packEvidence: {
          origin_refs: pack.origin_refs as PackOriginRef[] | undefined,
          retrieve_handle: typeof pack.retrieve_handle === "string" ? pack.retrieve_handle : undefined,
          removed_or_summarized: pack.removed_or_summarized as PackRemovedEntry[] | undefined,
          limitations: pack.limitations as string[] | undefined,
          staleness_hint: pack.staleness_hint as string | undefined,
          reversibility: typeof pack.reversibility === "string" ? pack.reversibility : undefined,
        },
      });
    }
    return applyResponseFormat(pack, resolveResponseFormat(args), tool);
  }
  return buildToolResponse(tool, rootCwd, args);
}

const TSV_TRUNCATE_LIMIT = 50;

function toTsv(header: string[], rows: string[][]): string {
  return [header, ...rows].map((r) => r.join("\t")).join("\n");
}

export interface TsvResult {
  text: string;
  truncationNote: string | undefined;
  isError: boolean;
}

/**
 * Variante TSV do dispatcher. Suportada apenas em `search` e `files`; outras
 * tools retornam `E_FORMAT_UNSUPPORTED`. Trunca em 50 resultados.
 */
export function buildToolResponseTsv(
  tool: McpToolName,
  cwd: string = process.cwd(),
  args?: Record<string, unknown>,
): TsvResult {
  if (tool !== "search" && tool !== "files") {
    return {
      text: JSON.stringify({
        state: "falha",
        message: `E_FORMAT_UNSUPPORTED: TSV não suportado para '${tool}'; use search ou files`,
      }),
      truncationNote: undefined,
      isError: true,
    };
  }

  const rootCwd = resolveWorkspaceRoot(cwd, process.env, { includeRegistry: false })?.rootPath ?? cwd;
  if (!readWorkspaceMetadata(rootCwd)) {
    return {
      text: JSON.stringify({ state: "falha", message: WORKSPACE_MISSING }),
      truncationNote: undefined,
      isError: true,
    };
  }

  if (tool === "search") {
    const payload = buildToolResponseInner("search", rootCwd, args);
    const candidates = Array.isArray(payload.candidates)
      ? (payload.candidates as Array<{ name: string; path: string; kind: string; start_line: number; score: number }>)
      : [];
    const total = candidates.length;
    const rows = candidates.slice(0, TSV_TRUNCATE_LIMIT).map((c) => [
      c.name,
      c.path,
      c.kind,
      String(c.start_line),
      String(c.score),
    ]);
    const text = toTsv(["name", "path", "kind", "line", "score"], rows);
    const truncationNote =
      total > TSV_TRUNCATE_LIMIT
        ? `Showing ${TSV_TRUNCATE_LIMIT} of ${total}; refine query for more.`
        : undefined;
    return { text, truncationNote, isError: payload.state === "falha" };
  }

  // tool === "files"
  const rows_data = readFilesForTsv(rootCwd);
  const total = rows_data.length;
  const rows = rows_data.slice(0, TSV_TRUNCATE_LIMIT).map((f) => [
    f.path,
    f.language,
    String(f.symbol_count),
  ]);
  const text = toTsv(["path", "language", "symbol_count"], rows);
  const truncationNote =
    total > TSV_TRUNCATE_LIMIT
      ? `Showing ${TSV_TRUNCATE_LIMIT} of ${total}; refine query for more.`
      : undefined;
  return { text, truncationNote, isError: false };
}

export const DEFAULT_MCP_RESPONSE_BUDGET = 20_000;

export function resolveResponseBudget(budgetOverride?: number): number {
  if (typeof budgetOverride === "number" && budgetOverride > 0) {
    return budgetOverride;
  }
  const rawEnv = process.env.ARGUS_MCP_RESPONSE_BUDGET;
  if (rawEnv) {
    const parsed = Number.parseInt(rawEnv, 10);
    if (!Number.isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return DEFAULT_MCP_RESPONSE_BUDGET;
}

/**
 * Aplica teto de tokens na resposta JSON serializada (Q1: default 20000,
 * configurável via `ARGUS_MCP_RESPONSE_BUDGET`).
 * Truncamento determinístico:
 * 1. mede tokens via countTokens; se <= budget, retorna payload intacto;
 * 2. corta arrays de resultado do maior para o menor campo até caber;
 * 3. se ainda acima, remove campos de conteúdo verbatim (snippet/content);
 * 4. se ainda acima, trunca strings longas;
 * 5. adiciona W_RESPONSE_TRUNCATED em limitations e degrada state para parcial quando era sucesso.
 */
export function enforceResponseBudget(
  payload: ToolResponsePayload,
  budgetOverride?: number,
): ToolResponsePayload {
  const budget = resolveResponseBudget(budgetOverride);
  const initialJson = JSON.stringify(payload);
  const initialTokens = countTokens(initialJson);

  if (initialTokens <= budget) {
    return payload;
  }

  const truncated: ToolResponsePayload = { ...payload };

  const limitations = Array.isArray(truncated.limitations)
    ? [...(truncated.limitations as string[])]
    : [];
  if (!limitations.includes("W_RESPONSE_TRUNCATED")) {
    limitations.push("W_RESPONSE_TRUNCATED");
  }
  truncated.limitations = limitations;

  if (truncated.state === "sucesso") {
    truncated.state = "parcial";
  }
  if (truncated.confidence) {
    truncated.confidence = "medium";
  }

  let currentTokens = countTokens(JSON.stringify(truncated));
  if (currentTokens <= budget) {
    return truncated;
  }

  // Cortar arrays de resultado do maior para o menor campo (ex.: chunks, results, symbols, files)
  const arrayKeys = Object.keys(truncated).filter(
    (key) =>
      key !== "limitations" &&
      Array.isArray(truncated[key]) &&
      (truncated[key] as unknown[]).length > 0,
  );

  arrayKeys.sort((a, b) => {
    const lenB = JSON.stringify(truncated[b]).length;
    const lenA = JSON.stringify(truncated[a]).length;
    return lenB - lenA;
  });

  for (const key of arrayKeys) {
    let arr = [...(truncated[key] as unknown[])];
    while (arr.length > 0 && currentTokens > budget) {
      const excess = currentTokens - budget;
      const arrTokens = countTokens(JSON.stringify(arr));
      const tokensPerItem = Math.max(1, arrTokens / arr.length);
      const toRemove = Math.max(1, Math.ceil(excess / tokensPerItem));
      const nextLen = Math.max(0, arr.length - toRemove);
      arr = arr.slice(0, nextLen);
      truncated[key] = arr;
      currentTokens = countTokens(JSON.stringify(truncated));
    }
    if (currentTokens <= budget) {
      return truncated;
    }
  }

  // Se ainda acima, remover campos de conteúdo verbatim (snippet/content)
  const verbatimKeys = [
    "snippet",
    "content",
    "packed_content",
    "text",
    "code",
    "body",
    "raw",
    "context",
  ];
  for (const key of verbatimKeys) {
    if (key in truncated && typeof truncated[key] === "string") {
      delete truncated[key];
      currentTokens = countTokens(JSON.stringify(truncated));
      if (currentTokens <= budget) {
        return truncated;
      }
    }
  }

  // Se ainda assim estiver acima (ex.: strings longas restantes)
  const stringKeys = Object.keys(truncated).filter(
    (key) =>
      key !== "state" &&
      key !== "message" &&
      key !== "limitations" &&
      typeof truncated[key] === "string" &&
      (truncated[key] as string).length > 0,
  );
  stringKeys.sort(
    (a, b) =>
      (truncated[b] as string).length - (truncated[a] as string).length,
  );

  for (const key of stringKeys) {
    let str = truncated[key] as string;
    while (currentTokens > budget) {
      if (str.length <= 1) {
        delete truncated[key];
        currentTokens = countTokens(JSON.stringify(truncated));
        break;
      }
      str = str.slice(0, Math.floor(str.length / 2));
      truncated[key] = str;
      currentTokens = countTokens(JSON.stringify(truncated));
    }
    if (currentTokens <= budget) {
      return truncated;
    }
  }

  return truncated;
}

export { STRUCTURAL_INDEX_SCHEMA_VERSION, SQLITE_SCHEMA_VERSION };
