// Tool `status`: saúde, staleness e confiança do índice local.
import { stubResponse } from "../../contracts/response-state.js";
import type { DiscoveryManifest } from "../../discovery/types.js";
import { ManifestCorruptedError, readManifest } from "../../discovery/manifest.js";
import { computeManifestStaleness } from "../../discovery/staleness.js";
import { readDirtyFlag } from "../../discovery/dirty-flag.js";
import type { StructuralIndex } from "../../extraction/types.js";
import { IndexDbCorruptedError, IndexDbSchemaError } from "../../storage/index-persistence.js";
import { getManifestPath, readWorkspaceMetadata, resolveRespectGitignore } from "../../workspace/workspace.js";
import { VaultEngine } from "../../memory/vault-engine.js";
import {
  ARGUS_MCP_TOOLS_ENV,
  DEFAULT_LISTED_MCP_TOOLS,
  MCP_TOOL_NAMES,
  resolveListedTools,
  type ListedToolsResolution,
} from "../tool-registry.js";
import { INDEX_MISSING, STALE_INDEX, WORKSPACE_MISSING, STRUCTURAL_INDEX_MISSING, PARTIAL_NO_MANIFEST_LIMITATIONS, PARTIAL_CORRUPTED_MANIFEST_LIMITATIONS, PARTIAL_STRUCTURAL_MISSING_LIMITATIONS, PARTIAL_CORRUPTED_STRUCTURAL_LIMITATIONS, STALE_RUN_SYNC, STALE_RUN_INDEX, STALE_UNKNOWN, loadStructuralIndex, mergeStructuralLimitations, buildIndexVersion } from "./common.js";
import type { ToolResponsePayload } from "./common.js";

/** Observabilidade da política ListTools (slim ≠ CallTool). */
export function buildMcpSurfaceStatus(
  resolution: ListedToolsResolution = resolveListedTools(process.env[ARGUS_MCP_TOOLS_ENV], {
    emitDiagnostic: false,
  }),
): Record<string, unknown> {
  const slim = resolution.mode === "default" ||
    (resolution.mode === "explicit" && resolution.listed.length <= DEFAULT_LISTED_MCP_TOOLS.length);

  return {
    slim,
    mode: resolution.mode,
    listed_tools: [...resolution.listed],
    listed_count: resolution.listed.length,
    registered_count: MCP_TOOL_NAMES.length,
    registered_tools: [...MCP_TOOL_NAMES],
    restore_all: `${ARGUS_MCP_TOOLS_ENV}=all`,
    note:
      "ListTools filtra descoberta; CallTool aceita todas as tools registradas mesmo unlisted. " +
      `Mudança de ${ARGUS_MCP_TOOLS_ENV} exige restart do MCP.`,
    ...(resolution.warning ? { warning: resolution.warning } : {}),
  };
}

function withMcpSurface(payload: ToolResponsePayload): ToolResponsePayload {
  return {
    ...payload,
    mcp_surface: buildMcpSurfaceStatus(),
  };
}

export function buildStatusResponse(cwd: string): ToolResponsePayload {
  const metadata = readWorkspaceMetadata(cwd);
  const memory = VaultEngine.status(cwd);

  if (!metadata) {
    return withMcpSurface({
      initialized: false,
      staleness: "unknown",
      pending_files_count: 0,
      coverage_by_language: {},
      index_version: null,
      storage_backend: null,
      schema_version: null,
      memory,
      ...stubResponse("falha", WORKSPACE_MISSING),
    });
  }

  let manifest: DiscoveryManifest | null;
  try {
    manifest = readManifest(getManifestPath(metadata.root_path));
  } catch (err) {
    if (err instanceof ManifestCorruptedError) {
      return withMcpSurface({
        initialized: true,
        staleness: "unknown",
        pending_files_count: 0,
        coverage_by_language: {},
        index_version: null,
        storage_backend: null,
          schema_version: null,
          memory,
        ...stubResponse("parcial", err.message, {
          limitations: PARTIAL_CORRUPTED_MANIFEST_LIMITATIONS,
          staleness_hint: `${STALE_RUN_INDEX}: Execute argus index para reconstruir o manifest.`,
        }),
      });
    }
    throw err;
  }

  if (!manifest) {
    return withMcpSurface({
      initialized: true,
      staleness: "unknown",
      pending_files_count: 0,
      coverage_by_language: {},
      index_version: null,
      storage_backend: null,
      schema_version: null,
      memory,
      ...stubResponse("parcial", INDEX_MISSING, {
        limitations: PARTIAL_NO_MANIFEST_LIMITATIONS,
        staleness_hint: `${STALE_RUN_INDEX}: Execute argus index para criar o manifest inicial.`,
      }),
    });
  }

  let structural: StructuralIndex | null = null;
  try {
    structural = loadStructuralIndex(metadata.root_path);
  } catch (err) {
    if (err instanceof IndexDbCorruptedError || err instanceof IndexDbSchemaError) {
      return withMcpSurface({
        initialized: true,
        staleness: "unknown",
        pending_files_count: 0,
        coverage_by_language: {},
        index_version: null,
        storage_backend: "sqlite",
        schema_version: null,
        memory,
        ...stubResponse("falha", err.message, {
          limitations: PARTIAL_CORRUPTED_STRUCTURAL_LIMITATIONS,
          staleness_hint: `${STALE_RUN_INDEX}: Execute argus index para reconstruir o índice estrutural.`,
        }),
      });
    }
    throw err;
  }

  const staleness = computeManifestStaleness(metadata.root_path, manifest, {
    respect_gitignore: resolveRespectGitignore(metadata),
  });
  const coverage = structural?.coverage_by_language ?? {};
  const dirtyFlag = readDirtyFlag(metadata.root_path);
  const basePayload = {
    initialized: true,
    staleness: staleness.staleness,
    pending_files_count: staleness.pending_files_count,
    coverage_by_language: coverage,
    index_version: buildIndexVersion(manifest, structural),
    storage_backend: structural ? ("sqlite" as const) : null,
    schema_version: structural?.schema_version ?? null,
    dirty_pending: dirtyFlag
      ? { paths: dirtyFlag.paths.length, force_full: dirtyFlag.force_full, since_ref: dirtyFlag.since_ref }
      : null,
    memory,
  };

  if (!structural) {
    return withMcpSurface({
      ...basePayload,
      ...stubResponse("parcial", STRUCTURAL_INDEX_MISSING, {
        limitations: PARTIAL_STRUCTURAL_MISSING_LIMITATIONS,
        staleness_hint: `${STALE_RUN_INDEX}: Execute argus index ou argus sync para gerar o índice SQLite.`,
      }),
    });
  }

  const structuralLimitations = mergeStructuralLimitations(structural);

  if (staleness.staleness === "fresh") {
    if (structuralLimitations.length > 0) {
      return withMcpSurface({
        ...basePayload,
        ...stubResponse("parcial", "Índice estrutural atualizado com limitações de cobertura.", {
          limitations: structuralLimitations,
        }),
      });
    }

    return withMcpSurface({
      ...basePayload,
      ...stubResponse("sucesso", "Índice de arquivos e extração estrutural atualizados (SQLite)."),
    });
  }

  if (staleness.staleness === "stale") {
    return withMcpSurface({
      ...basePayload,
      ...stubResponse("stale", STALE_INDEX, {
        limitations: structuralLimitations,
        staleness_hint: `${STALE_RUN_SYNC}: Execute argus sync para sincronizar o delta pendente.`,
      }),
    });
  }

  return withMcpSurface({
    ...basePayload,
    ...stubResponse("parcial", STALE_INDEX, {
      limitations: mergeStructuralLimitations(structural, [
        "Não foi possível determinar staleness com segurança.",
      ]),
      staleness_hint: `${STALE_UNKNOWN}: Execute argus sync se o filesystem mudou recentemente.`,
    }),
  });
}
