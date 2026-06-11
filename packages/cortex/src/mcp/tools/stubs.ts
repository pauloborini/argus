import { stubResponse } from "../../contracts/response-state.js";
import type { OperationalEnvelope } from "../../contracts/response-state.js";
import { readWorkspaceMetadata } from "../../workspace/workspace.js";
import type { McpToolName } from "../tool-registry.js";

export interface ToolStubPayload extends OperationalEnvelope {
  [key: string]: unknown;
}

const INDEX_MISSING = "E_INDEX_MISSING: Índice não inicializado; execute init/index";
const WORKSPACE_MISSING =
  "E_WORKSPACE_INVALID: Workspace não preparado ou path inválido. Execute cortex init.";
const PARTIAL_LIMITATIONS = [
  "Índice operacional indisponível; discovery/fingerprint previstos em S04+.",
];

function buildStatusStub(cwd: string): ToolStubPayload {
  const metadata = readWorkspaceMetadata(cwd);

  if (!metadata) {
    return {
      initialized: false,
      staleness: "unknown",
      pending_files_count: 0,
      coverage_by_language: {},
      index_version: null,
      ...stubResponse("falha", WORKSPACE_MISSING),
    };
  }

  return {
    initialized: true,
    staleness: "unknown",
    pending_files_count: 0,
    coverage_by_language: {},
    index_version: null,
    ...stubResponse("parcial", INDEX_MISSING, {
      limitations: PARTIAL_LIMITATIONS,
      staleness_hint: "Índice ainda não construído; execute index quando disponível (S04+).",
    }),
  };
}

/** Stubs honestos por tool — campos vazios alinhados a SURFACE_MCP_CLI.md (S02) */
export function buildToolStub(tool: McpToolName, cwd: string = process.cwd()): ToolStubPayload {
  if (!readWorkspaceMetadata(cwd) && tool !== "status") {
    return {
      ...stubResponse("falha", WORKSPACE_MISSING),
    };
  }

  switch (tool) {
    case "search":
      return {
        candidates: [],
        ...stubResponse("falha", INDEX_MISSING),
      };
    case "explore":
      return {
        summary: "",
        central_symbols: [],
        relevant_files: [],
        ...stubResponse("parcial", "E_PARTIAL_COVERAGE: Cobertura parcial para esta linguagem/cenário", {
          limitations: PARTIAL_LIMITATIONS,
        }),
      };
    case "trace":
      return {
        paths: [],
        ...stubResponse("falha", INDEX_MISSING),
      };
    case "impact":
      return {
        direct_affected: [],
        indirect_affected: [],
        files: [],
        tests: [],
        risk_summary: "",
        ...stubResponse("falha", INDEX_MISSING),
      };
    case "diff_impact":
      return {
        changed_files: [],
        changed_symbols: [],
        affected_areas: [],
        affected_tests: [],
        risk_summary: "",
        ...stubResponse("falha", INDEX_MISSING),
      };
    case "files":
      return {
        tree: [],
        languages: [],
        ...stubResponse("falha", INDEX_MISSING),
      };
    case "pack_context":
      return {
        packed_context: null,
        origin_refs: [],
        removed_or_summarized: [],
        reversibility: "none",
        ...stubResponse("falha", "E_INSUFFICIENT_EVIDENCE: Evidência insuficiente para responder"),
      };
    case "status":
      return buildStatusStub(cwd);
  }
}
