// Dispatcher das tools + formatação de envelope (concise/detailed).
import { stubResponse } from "../../contracts/response-state.js";
import { STRUCTURAL_INDEX_SCHEMA_VERSION } from "../../extraction/types.js";
import { SQLITE_SCHEMA_VERSION } from "../../storage/sqlite-prepared.js";
import { readWorkspaceMetadata } from "../../workspace/workspace.js";
import type { McpToolName } from "../tool-registry.js";
import { WORKSPACE_MISSING, buildIndexEnvelope, isWithinPath } from "./common.js";
import type { ToolResponsePayload, SearchArgs, FilesArgs, ExploreArgs, TraceArgs, ImpactArgs, DiffImpactArgs, PackContextArgs, RetrieveArgs, StructuralLoadMode } from "./common.js";
import { buildStatusResponse } from "./status.js";
import { buildFilesResponse, applyFilesFilters } from "./files.js";
import { buildSearchResponse } from "./search.js";
import { buildSemanticSearchDegraded, buildSemanticSearchResponse } from "./semantic-search.js";
import type { SemanticSearchArgs, SemanticSearchDeps } from "./semantic-search.js";
import { buildTraceResponse } from "./trace.js";
import { buildImpactResponse } from "./impact.js";
import { buildRetrieveResponse, buildPackContextResponse } from "./pack.js";
import { buildDiffImpactResponse } from "./diff-impact.js";
import { buildExploreResponse } from "./explore.js";

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
 * envelope cai ao sinal mínimo:
 *  - `confidence` dropado (100% derivável de `state`);
 *  - `message` mantém só o código `E_*`; prosa estática (sucesso) some;
 *  - `limitations` e `staleness_hint` (prosa pt-br) saem — `state` já carrega o
 *    sinal operacional; a prosa volta em `detailed`.
 * Campos de domínio (candidates, hops, tree, …) são preservados intactos.
 */
function applyResponseFormat(
  payload: ToolResponsePayload,
  format: ResponseFormat,
): ToolResponsePayload {
  if (format === "detailed") {
    return payload;
  }

  const { message, confidence, limitations, staleness_hint, ...rest } = payload;
  void confidence;
  void limitations;
  void staleness_hint;
  const out = rest as ToolResponsePayload;

  const messageCode = envelopeCode(typeof message === "string" ? message : undefined);
  if (messageCode) {
    out.message = messageCode;
  }

  return out;
}

export function buildToolResponse(
  tool: McpToolName,
  cwd: string = process.cwd(),
  args?: Record<string, unknown>,
): ToolResponsePayload {
  return applyResponseFormat(
    buildToolResponseInner(tool, cwd, args),
    resolveResponseFormat(args),
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

  // search/files/trace/impact não precisam do grafo materializado: carregam
  // meta-only e resolvem cobertura/tree/grafo por query alvo (trace/impact via
  // LazyTraceGraph), matando o full-load no caminho quente.
  const mode: StructuralLoadMode =
    tool === "search" ||
    tool === "files" ||
    tool === "trace" ||
    tool === "impact" ||
    tool === "semantic_search"
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
    case "retrieve":
      return buildRetrieveResponse(cwd, args as RetrieveArgs | undefined);
    case "status":
      return buildStatusResponse(cwd);
    case "semantic_search":
      // Caminho síncrono: degrada para fallback lexical (sem embeddar a query).
      // A busca densa real exige embed assíncrono → buildToolResponseAsync.
      return buildSemanticSearchDegraded(cwd, envelope, args as SemanticSearchArgs | undefined);
  }
}

/**
 * Variante assíncrona do dispatcher. Só `semantic_search` precisa de await (embed
 * da query); as outras 9 tools delegam ao caminho síncrono. Usada pelo servidor
 * MCP e pelo comando CLI `semantic-search`.
 */
export async function buildToolResponseAsync(
  tool: McpToolName,
  cwd: string = process.cwd(),
  args?: Record<string, unknown>,
  deps?: SemanticSearchDeps,
): Promise<ToolResponsePayload> {
  if (tool === "semantic_search") {
    if (!readWorkspaceMetadata(cwd)) {
      return applyResponseFormat(
        buildToolResponseInner(tool, cwd, args),
        resolveResponseFormat(args),
      );
    }
    const envelope = buildIndexEnvelope(cwd, "lite");
    const inner = await buildSemanticSearchResponse(
      cwd,
      envelope,
      args as SemanticSearchArgs | undefined,
      deps,
    );
    return applyResponseFormat(inner, resolveResponseFormat(args));
  }
  return buildToolResponse(tool, cwd, args);
}

export { STRUCTURAL_INDEX_SCHEMA_VERSION, SQLITE_SCHEMA_VERSION };
