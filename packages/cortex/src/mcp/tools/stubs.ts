import { stubResponse } from "../../contracts/response-state.js";
import type { OperationalEnvelope } from "../../contracts/response-state.js";
import type { McpToolName } from "../tool-registry.js";

export interface ToolStubPayload extends OperationalEnvelope {
  [key: string]: unknown;
}

/** Stubs honestos por tool — shape mínimo conforme PLAN §6.2 */
export function buildToolStub(tool: McpToolName): ToolStubPayload {
  switch (tool) {
    case "search":
      return {
        candidates: [],
        ...stubResponse("falha", "E_INDEX_MISSING: Índice não inicializado; execute init/index"),
      };
    case "explore":
      return {
        summary: "",
        central_symbols: [],
        relevant_files: [],
        ...stubResponse("parcial", "E_PARTIAL_COVERAGE: Cobertura parcial para esta linguagem/cenário"),
      };
    case "trace":
      return {
        paths: [],
        ...stubResponse("falha", "E_INDEX_MISSING: Índice não inicializado; execute init/index"),
      };
    case "impact":
      return {
        affected: [],
        ...stubResponse("falha", "E_INDEX_MISSING: Índice não inicializado; execute init/index"),
      };
    case "diff_impact":
      return {
        changed: [],
        tests: [],
        ...stubResponse("falha", "E_INDEX_MISSING: Índice não inicializado; execute init/index"),
      };
    case "files":
      return {
        entries: [],
        ...stubResponse("falha", "E_INDEX_MISSING: Índice não inicializado; execute init/index"),
      };
    case "pack_context":
      return {
        pack: null,
        ...stubResponse("falha", "E_INSUFFICIENT_EVIDENCE: Evidência insuficiente para responder"),
      };
    case "status":
      return {
        ready: false,
        stale: true,
        pending: ["index"],
        ...stubResponse("parcial", "E_INDEX_MISSING: Índice não inicializado; execute init/index"),
      };
  }
}
