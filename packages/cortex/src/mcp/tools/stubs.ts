import { stubResponse } from "../../contracts/response-state.js";
import type { ResponseState } from "../../contracts/response-state.js";
import type { OperationalEnvelope } from "../../contracts/response-state.js";
import type { DiscoveryManifest } from "../../discovery/types.js";
import { ManifestCorruptedError, readManifest } from "../../discovery/manifest.js";
import { computeManifestStaleness } from "../../discovery/staleness.js";
import { collectIndexedLanguages, buildFilesTree } from "../../extraction/files-tree.js";
import type { StructuralIndex } from "../../extraction/types.js";
import { STRUCTURAL_INDEX_SCHEMA_VERSION } from "../../extraction/types.js";
import {
  IndexDbCorruptedError,
  IndexDbSchemaError,
  loadStructuralIndexForRead,
} from "../../storage/index-persistence.js";
import { SQLITE_SCHEMA_VERSION } from "../../storage/sqlite-prepared.js";
import {
  getManifestPath,
  readWorkspaceMetadata,
} from "../../workspace/workspace.js";
import type { McpToolName } from "../tool-registry.js";

export interface ToolStubPayload extends OperationalEnvelope {
  [key: string]: unknown;
}

const INDEX_MISSING = "E_INDEX_MISSING: Índice não inicializado; execute init/index";
const STALE_INDEX = "E_STALE_INDEX: Índice desatualizado; resultados podem estar incompletos";
const WORKSPACE_MISSING =
  "E_WORKSPACE_INVALID: Workspace não preparado ou path inválido. Execute cortex init.";
const STRUCTURAL_INDEX_MISSING =
  "E_INDEX_MISSING: Manifest disponível; índice estrutural ausente — execute cortex index ou cortex sync.";
const FTS_RETRIEVAL_PENDING =
  "FTS lexical local disponível (S06); busca rankeada e retrieval semântico para o agente aguardam S08.";
const PARTIAL_NO_MANIFEST_LIMITATIONS = [
  "Manifest de arquivos ausente; execute cortex index para iniciar o inventário.",
];
const PARTIAL_CORRUPTED_MANIFEST_LIMITATIONS = [
  "Manifest de arquivos corrompido; execute cortex index para recriar o inventário.",
];
const PARTIAL_STRUCTURAL_MISSING_LIMITATIONS = [
  "Manifest presente, mas índice SQLite ausente; execute cortex index ou cortex sync.",
];
const PARTIAL_FTS_LIMITATIONS = [
  "Índice SQLite com FTS lexical local (S06); ranking e retrieval útil para o agente aguardam S08.",
];
const PARTIAL_CORRUPTED_STRUCTURAL_LIMITATIONS = [
  "Índice SQLite corrompido; execute cortex index para reconstruir.",
];

interface SemanticStubEnvelope {
  state: ResponseState;
  message: string;
  limitations?: string[];
  staleness_hint?: string;
  structuralIndex: StructuralIndex | null;
  storage_backend: "sqlite" | null;
  schema_version: string | null;
}

function loadStructuralIndex(rootPath: string): StructuralIndex | null {
  return loadStructuralIndexForRead(rootPath);
}

function mergeStructuralLimitations(
  structural: StructuralIndex | null,
  base: string[] = [],
): string[] {
  if (!structural?.extraction_limitations?.length) {
    return base;
  }
  return [...base, ...structural.extraction_limitations];
}

function buildIndexVersion(manifest: DiscoveryManifest, structural: StructuralIndex | null): string {
  if (structural) {
    return `${manifest.schema_version}+sqlite@${structural.schema_version}`;
  }
  return manifest.schema_version;
}

export function buildCoverageSummaryFromIndex(
  structural: StructuralIndex | null,
): Record<string, unknown> {
  if (!structural) {
    return {};
  }
  return structural.coverage_by_language;
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
      storage_backend: null,
      schema_version: null,
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
        storage_backend: null,
        schema_version: null,
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
      storage_backend: null,
      schema_version: null,
      ...stubResponse("parcial", INDEX_MISSING, {
        limitations: PARTIAL_NO_MANIFEST_LIMITATIONS,
        staleness_hint: "Execute cortex index para criar o manifest inicial.",
      }),
    };
  }

  let structural: StructuralIndex | null = null;
  try {
    structural = loadStructuralIndex(metadata.root_path);
  } catch (err) {
    if (err instanceof IndexDbCorruptedError || err instanceof IndexDbSchemaError) {
      return {
        initialized: true,
        staleness: "unknown",
        pending_files_count: 0,
        coverage_by_language: {},
        index_version: null,
        storage_backend: "sqlite",
        schema_version: null,
        ...stubResponse("falha", err.message, {
          limitations: PARTIAL_CORRUPTED_STRUCTURAL_LIMITATIONS,
          staleness_hint: "Execute cortex index para reconstruir o índice estrutural.",
        }),
      };
    }
    throw err;
  }

  const staleness = computeManifestStaleness(metadata.root_path, manifest);
  const coverage = structural?.coverage_by_language ?? {};
  const basePayload = {
    initialized: true,
    staleness: staleness.staleness,
    pending_files_count: staleness.pending_files_count,
    coverage_by_language: coverage,
    index_version: buildIndexVersion(manifest, structural),
    storage_backend: structural ? ("sqlite" as const) : null,
    schema_version: structural?.schema_version ?? null,
  };

  if (!structural) {
    return {
      ...basePayload,
      ...stubResponse("parcial", STRUCTURAL_INDEX_MISSING, {
        limitations: PARTIAL_STRUCTURAL_MISSING_LIMITATIONS,
        staleness_hint: "Execute cortex index ou cortex sync para gerar o índice SQLite.",
      }),
    };
  }

  const structuralLimitations = mergeStructuralLimitations(structural);

  if (staleness.staleness === "fresh") {
    if (structuralLimitations.length > 0) {
      return {
        ...basePayload,
        ...stubResponse("parcial", "Índice estrutural atualizado com limitações de cobertura.", {
          limitations: structuralLimitations,
        }),
      };
    }

    return {
      ...basePayload,
      ...stubResponse("sucesso", "Índice de arquivos e extração estrutural atualizados (SQLite)."),
    };
  }

  if (staleness.staleness === "stale") {
    return {
      ...basePayload,
      ...stubResponse("stale", STALE_INDEX, {
        limitations: structuralLimitations,
        staleness_hint: "Execute cortex sync para sincronizar o delta pendente.",
      }),
    };
  }

  return {
    ...basePayload,
    ...stubResponse("parcial", STALE_INDEX, {
      limitations: mergeStructuralLimitations(structural, [
        "Não foi possível determinar staleness com segurança.",
      ]),
      staleness_hint: "Execute cortex sync se o filesystem mudou recentemente.",
    }),
  };
}

function buildSemanticStubEnvelope(cwd: string): SemanticStubEnvelope {
  const metadata = readWorkspaceMetadata(cwd);
  if (!metadata) {
    return {
      state: "falha",
      message: WORKSPACE_MISSING,
      structuralIndex: null,
      storage_backend: null,
      schema_version: null,
    };
  }

  let manifest: DiscoveryManifest | null;
  try {
    manifest = readManifest(getManifestPath(metadata.root_path));
  } catch (err) {
    if (err instanceof ManifestCorruptedError) {
      return {
        state: "parcial",
        message: err.message,
        limitations: PARTIAL_CORRUPTED_MANIFEST_LIMITATIONS,
        staleness_hint: "Execute cortex index para reconstruir o manifest.",
        structuralIndex: null,
        storage_backend: null,
        schema_version: null,
      };
    }
    throw err;
  }

  if (!manifest) {
    return {
      state: "parcial",
      message: INDEX_MISSING,
      limitations: PARTIAL_NO_MANIFEST_LIMITATIONS,
      staleness_hint: "Execute cortex index para criar o manifest inicial.",
      structuralIndex: null,
      storage_backend: null,
      schema_version: null,
    };
  }

  let structural: StructuralIndex | null = null;
  try {
    structural = loadStructuralIndex(metadata.root_path);
  } catch (err) {
    if (err instanceof IndexDbCorruptedError || err instanceof IndexDbSchemaError) {
      return {
        state: "falha",
        message: err.message,
        limitations: PARTIAL_CORRUPTED_STRUCTURAL_LIMITATIONS,
        structuralIndex: null,
        storage_backend: "sqlite",
        schema_version: null,
      };
    }
    throw err;
  }

  const storage_backend = structural ? ("sqlite" as const) : null;
  const schema_version = structural?.schema_version ?? null;

  const staleness = computeManifestStaleness(metadata.root_path, manifest);
  if (staleness.staleness === "stale") {
    return {
      state: "stale",
      message: STALE_INDEX,
      limitations: structural ? PARTIAL_FTS_LIMITATIONS : PARTIAL_STRUCTURAL_MISSING_LIMITATIONS,
      staleness_hint: "Execute cortex sync para sincronizar o delta pendente.",
      structuralIndex: structural,
      storage_backend,
      schema_version,
    };
  }

  if (staleness.staleness === "unknown") {
    return {
      state: "parcial",
      message: STALE_INDEX,
      limitations: structural ? PARTIAL_FTS_LIMITATIONS : PARTIAL_STRUCTURAL_MISSING_LIMITATIONS,
      staleness_hint: "Não foi possível determinar staleness com segurança.",
      structuralIndex: structural,
      storage_backend,
      schema_version,
    };
  }

  if (!structural) {
    return {
      state: "parcial",
      message: STRUCTURAL_INDEX_MISSING,
      limitations: PARTIAL_STRUCTURAL_MISSING_LIMITATIONS,
      staleness_hint: "Execute cortex index ou cortex sync para gerar o índice SQLite.",
      structuralIndex: null,
      storage_backend: null,
      schema_version: null,
    };
  }

  return {
    state: "parcial",
    message: FTS_RETRIEVAL_PENDING,
    limitations: mergeStructuralLimitations(structural, PARTIAL_FTS_LIMITATIONS),
    structuralIndex: structural,
    storage_backend,
    schema_version,
  };
}

function buildFilesStub(semanticStub: SemanticStubEnvelope): ToolStubPayload {
  const structural = semanticStub.structuralIndex;

  if (semanticStub.state === "falha" || !structural) {
    return {
      tree: [],
      languages: [],
      storage_backend: semanticStub.storage_backend,
      schema_version: semanticStub.schema_version,
      ...stubResponse(semanticStub.state, semanticStub.message, {
        limitations: semanticStub.limitations,
        staleness_hint: semanticStub.staleness_hint,
      }),
    };
  }

  const tree = buildFilesTree(structural.files);
  const languages = collectIndexedLanguages(structural.files);

  if (semanticStub.state === "stale") {
    return {
      tree,
      languages,
      storage_backend: semanticStub.storage_backend,
      schema_version: semanticStub.schema_version,
      ...stubResponse("stale", semanticStub.message, {
        limitations: semanticStub.limitations,
        staleness_hint: semanticStub.staleness_hint,
      }),
    };
  }

  const structuralLimitations = mergeStructuralLimitations(structural);
  if (structuralLimitations.length > 0) {
    return {
      tree,
      languages,
      storage_backend: semanticStub.storage_backend,
      schema_version: semanticStub.schema_version,
      ...stubResponse("parcial", "Estrutura indexada com limitações de cobertura.", {
        limitations: structuralLimitations,
      }),
    };
  }

  return {
    tree,
    languages,
    storage_backend: semanticStub.storage_backend,
    schema_version: semanticStub.schema_version,
    ...stubResponse("sucesso", "Estrutura indexada com contagens de símbolos por arquivo."),
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
        storage_backend: semanticStub.storage_backend,
        schema_version: semanticStub.schema_version,
        ...stubResponse(semanticStub.state, semanticStub.message, {
          limitations: semanticStub.limitations,
          staleness_hint: semanticStub.staleness_hint,
        }),
      };
    case "explore":
      return {
        summary: "",
        central_symbols: [],
        relevant_files: [],
        ...stubResponse(semanticStub.state, semanticStub.message, {
          limitations: semanticStub.limitations,
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
      return buildFilesStub(semanticStub);
    case "pack_context":
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
    case "status":
      return buildStatusStub(cwd);
  }
}

export { STRUCTURAL_INDEX_SCHEMA_VERSION, SQLITE_SCHEMA_VERSION };
