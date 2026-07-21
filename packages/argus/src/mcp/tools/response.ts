// Dispatcher das tools + formatação de envelope (concise/detailed).
import { stubResponse } from "../../contracts/response-state.js";
import { STRUCTURAL_INDEX_SCHEMA_VERSION } from "../../extraction/types.js";
import { SQLITE_SCHEMA_VERSION } from "../../storage/sqlite-prepared.js";
import { readWorkspaceMetadata } from "../../workspace/workspace.js";
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
  return applyResponseFormat(
    buildToolResponseInner(tool, cwd, args),
    resolveResponseFormat(args),
    tool,
  );
}

function buildToolResponseInner(
  tool: McpToolName,
  cwd: string = process.cwd(),
  args?: Record<string, unknown>,
): ToolResponsePayload {
  if (tool === "status" && !isWithinPath(process.cwd(), cwd)) {
    const currentWorkspace = readWorkspaceMetadata(process.cwd());
    if (!currentWorkspace || !isWithinPath(currentWorkspace.root_path, cwd)) {
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
  }

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
  if (tool === "semantic_search") {
    const domain = (args as SemanticSearchArgs | undefined)?.domain;
    if (!readWorkspaceMetadata(cwd) && domain !== "memory") {
      return applyResponseFormat(
        buildToolResponseInner(tool, cwd, args),
        resolveResponseFormat(args),
        tool,
      );
    }
    const envelope = buildIndexEnvelope(cwd, "lite");
    const inner = await buildSemanticSearchResponse(
      cwd,
      envelope,
      args as SemanticSearchArgs | undefined,
      deps,
    );
    return applyResponseFormat(inner, resolveResponseFormat(args), tool);
  }
  if (tool === "remember") {
    return applyResponseFormat(
      await buildRememberResponse(cwd, args as RememberArgs | undefined, deps?.embedder),
      resolveResponseFormat(args),
      tool,
    );
  }
  if (tool === "recall") {
    return applyResponseFormat(
      await buildRecallResponseAsync(cwd, args as RecallArgs | undefined, deps?.embedder),
      resolveResponseFormat(args),
      tool,
    );
  }
  if (tool === "pack_context" && (args as PackContextArgs | undefined)?.synthesize === true) {
    const envelope = buildIndexEnvelope(cwd, "lite");
    const pack = buildPackContextResponse(cwd, envelope, args as PackContextArgs | undefined);
    if (pack.state !== "falha" && typeof pack.packed_context === "string") {
      pack.synthesis = await ThinkEngine.think(String((args as PackContextArgs | undefined)?.goal ?? ""), {
        context: pack.packed_context,
        cwd,
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
  return buildToolResponse(tool, cwd, args);
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

  if (!readWorkspaceMetadata(cwd)) {
    return {
      text: JSON.stringify({ state: "falha", message: WORKSPACE_MISSING }),
      truncationNote: undefined,
      isError: true,
    };
  }

  if (tool === "search") {
    const payload = buildToolResponseInner("search", cwd, args);
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
  const rows_data = readFilesForTsv(cwd);
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

export { STRUCTURAL_INDEX_SCHEMA_VERSION, SQLITE_SCHEMA_VERSION };
