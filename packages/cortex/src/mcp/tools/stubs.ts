import { stubResponse } from "../../contracts/response-state.js";
import type { ResponseState } from "../../contracts/response-state.js";
import type { OperationalEnvelope } from "../../contracts/response-state.js";
import type { DiscoveryManifest } from "../../discovery/types.js";
import { ManifestCorruptedError, readManifest } from "../../discovery/manifest.js";
import { computeManifestStaleness } from "../../discovery/staleness.js";
import { getManifestPath, readWorkspaceMetadata } from "../../workspace/workspace.js";
import type { McpToolName } from "../tool-registry.js";

export interface ToolStubPayload extends OperationalEnvelope {
  [key: string]: unknown;
}

const INDEX_MISSING = "E_INDEX_MISSING: Índice não inicializado; execute init/index";
const STALE_INDEX = "E_STALE_INDEX: Índice desatualizado; resultados podem estar incompletos";
const WORKSPACE_MISSING =
  "E_WORKSPACE_INVALID: Workspace não preparado ou path inválido. Execute cortex init.";
const PARTIAL_LIMITATIONS = [
  "Inventário de arquivos disponível, mas índice semântico permanece pendente (S05+).",
];
const PARTIAL_NO_MANIFEST_LIMITATIONS = [
  "Manifest de arquivos ausente; execute cortex index para iniciar o inventário.",
];
const PARTIAL_CORRUPTED_MANIFEST_LIMITATIONS = [
  "Manifest de arquivos corrompido; execute cortex index para recriar o inventário.",
];
const SEMANTIC_INDEX_PENDING =
  "E_INDEX_MISSING: Manifest disponível; índice semântico será entregue em S05+.";

interface SemanticStubEnvelope {
  state: ResponseState;
  message: string;
  limitations?: string[];
  staleness_hint?: string;
}

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

  let manifest: DiscoveryManifest | null;
  try {
    manifest = readManifest(getManifestPath(metadata.root_path));
  } catch (err) {
    if (err instanceof ManifestCorruptedError) {
      return {
        initialized: true,
        staleness: "unknown",
        pending_files_count: 0,
        coverage_by_language: {},
        index_version: null,
        ...stubResponse("parcial", err.message, {
          limitations: PARTIAL_CORRUPTED_MANIFEST_LIMITATIONS,
          staleness_hint: "Execute cortex index para reconstruir o manifest.",
        }),
      };
    }
    throw err;
  }

  if (!manifest) {
    return {
      initialized: true,
      staleness: "unknown",
      pending_files_count: 0,
      coverage_by_language: {},
      index_version: null,
      ...stubResponse("parcial", INDEX_MISSING, {
        limitations: PARTIAL_NO_MANIFEST_LIMITATIONS,
        staleness_hint: "Execute cortex index para criar o manifest inicial.",
      }),
    };
  }

  const staleness = computeManifestStaleness(metadata.root_path, manifest);
  const basePayload = {
    initialized: true,
    staleness: staleness.staleness,
    pending_files_count: staleness.pending_files_count,
    coverage_by_language: {},
    index_version: manifest.schema_version,
  };

  if (staleness.staleness === "fresh") {
    return {
      ...basePayload,
      ...stubResponse("sucesso", "Índice de arquivos atualizado."),
    };
  }

  if (staleness.staleness === "stale") {
    return {
      ...basePayload,
      ...stubResponse("stale", STALE_INDEX, {
        staleness_hint: "Execute cortex sync para sincronizar o delta pendente.",
      }),
    };
  }

  return {
    ...basePayload,
    ...stubResponse("parcial", STALE_INDEX, {
      limitations: PARTIAL_LIMITATIONS,
      staleness_hint: "Não foi possível determinar staleness com segurança.",
    }),
  };
}

function buildSemanticStubEnvelope(cwd: string): SemanticStubEnvelope {
  const metadata = readWorkspaceMetadata(cwd);
  if (!metadata) {
    return { state: "falha", message: WORKSPACE_MISSING };
  }

  let manifest: DiscoveryManifest | null;
  try {
    manifest = readManifest(getManifestPath(metadata.root_path));
  } catch (err) {
    if (err instanceof ManifestCorruptedError) {
      return {
        state: "falha",
        message: err.message,
        limitations: PARTIAL_CORRUPTED_MANIFEST_LIMITATIONS,
      };
    }
    throw err;
  }

  if (!manifest) {
    return {
      state: "falha",
      message: INDEX_MISSING,
      limitations: PARTIAL_NO_MANIFEST_LIMITATIONS,
      staleness_hint: "Execute cortex index para criar o manifest inicial.",
    };
  }

  const staleness = computeManifestStaleness(metadata.root_path, manifest);
  if (staleness.staleness === "stale") {
    return {
      state: "stale",
      message: STALE_INDEX,
      limitations: PARTIAL_LIMITATIONS,
      staleness_hint: "Execute cortex sync para sincronizar o delta pendente.",
    };
  }

  if (staleness.staleness === "unknown") {
    return {
      state: "parcial",
      message: STALE_INDEX,
      limitations: PARTIAL_LIMITATIONS,
      staleness_hint: "Não foi possível determinar staleness com segurança.",
    };
  }

  return {
    state: "falha",
    message: SEMANTIC_INDEX_PENDING,
    limitations: PARTIAL_LIMITATIONS,
  };
}

/** Stubs honestos por tool — campos vazios alinhados a SURFACE_MCP_CLI.md (S02) */
export function buildToolStub(tool: McpToolName, cwd: string = process.cwd()): ToolStubPayload {
  if (!readWorkspaceMetadata(cwd) && tool !== "status") {
    return {
      ...stubResponse("falha", WORKSPACE_MISSING),
    };
  }

  const semanticStub = buildSemanticStubEnvelope(cwd);

  switch (tool) {
    case "search":
      return {
        candidates: [],
        ...stubResponse(semanticStub.state, semanticStub.message, {
          limitations: semanticStub.limitations,
          staleness_hint: semanticStub.staleness_hint,
        }),
      };
    case "explore":
      if (semanticStub.state === "stale" || semanticStub.state === "parcial") {
        return {
          summary: "",
          central_symbols: [],
          relevant_files: [],
          ...stubResponse(semanticStub.state, semanticStub.message, {
            limitations: semanticStub.limitations,
            staleness_hint: semanticStub.staleness_hint,
          }),
        };
      }
      return {
        summary: "",
        central_symbols: [],
        relevant_files: [],
        ...stubResponse("parcial", "E_PARTIAL_COVERAGE: Cobertura parcial para esta linguagem/cenário", {
          limitations: semanticStub.limitations ?? PARTIAL_NO_MANIFEST_LIMITATIONS,
          staleness_hint: semanticStub.staleness_hint,
        }),
      };
    case "trace":
      return {
        paths: [],
        ...stubResponse(semanticStub.state, semanticStub.message, {
          limitations: semanticStub.limitations,
          staleness_hint: semanticStub.staleness_hint,
        }),
      };
    case "impact":
      return {
        direct_affected: [],
        indirect_affected: [],
        files: [],
        tests: [],
        risk_summary: "",
        ...stubResponse(semanticStub.state, semanticStub.message, {
          limitations: semanticStub.limitations,
          staleness_hint: semanticStub.staleness_hint,
        }),
      };
    case "diff_impact":
      return {
        changed_files: [],
        changed_symbols: [],
        affected_areas: [],
        affected_tests: [],
        risk_summary: "",
        ...stubResponse(semanticStub.state, semanticStub.message, {
          limitations: semanticStub.limitations,
          staleness_hint: semanticStub.staleness_hint,
        }),
      };
    case "files":
      return {
        tree: [],
        languages: [],
        ...stubResponse(semanticStub.state, semanticStub.message, {
          limitations: semanticStub.limitations,
          staleness_hint: semanticStub.staleness_hint,
        }),
      };
    case "pack_context":
      if (semanticStub.state === "stale" || semanticStub.state === "parcial") {
        return {
          packed_context: null,
          origin_refs: [],
          removed_or_summarized: [],
          reversibility: "none",
          ...stubResponse(semanticStub.state, semanticStub.message, {
            limitations: semanticStub.limitations,
            staleness_hint: semanticStub.staleness_hint,
          }),
        };
      }
      return {
        packed_context: null,
        origin_refs: [],
        removed_or_summarized: [],
        reversibility: "none",
        ...stubResponse("falha", "E_INSUFFICIENT_EVIDENCE: Evidência insuficiente para responder", {
          limitations: semanticStub.limitations,
        }),
      };
    case "status":
      return buildStatusStub(cwd);
  }
}
