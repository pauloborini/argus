// Tool `status`: saúde, staleness e confiança do índice local.
import { stubResponse } from "../../contracts/response-state.js";
import type { DiscoveryManifest } from "../../discovery/types.js";
import { ManifestCorruptedError, readManifest } from "../../discovery/manifest.js";
import { computeManifestStaleness } from "../../discovery/staleness.js";
import { readDirtyFlag } from "../../discovery/dirty-flag.js";
import type { StructuralIndex } from "../../extraction/types.js";
import { IndexDbCorruptedError, IndexDbSchemaError } from "../../storage/index-persistence.js";
import { getManifestPath, resolveRespectGitignore } from "../../workspace/workspace.js";
import { resolveWorkspaceRoot } from "../../workspace/resolve-workspace.js";
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

/**
 * Sincronização estrutural exposta no payload de status.
 *
 * `last_sync_at` espelha `manifest.generated_at` (gravado a cada sync bem ou
 * sem conteúdo — Plano 2 / P4 default). É distinto de `memory.last_sync_at`
 * (cofre) para remover a ambiguidade "há 8 h" pós-sync estrutural.
 */
export interface StructuralStatus {
  last_sync_at: string | null;
}

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

/**
 * Status estrutural + memória no mesmo root canônico (pós-heal).
 * `cwd` é start de discovery; I/O de estado usa somente `rootPath`.
 */
export function buildStatusResponse(cwd: string): ToolResponsePayload {
  const resolved = resolveWorkspaceRoot(cwd, process.env, { includeRegistry: false });
  if (!resolved) {
    return withMcpSurface({
      initialized: false,
      staleness: "unknown",
      pending_files_count: 0,
      coverage_by_language: {},
      index_version: null,
      storage_backend: null,
      schema_version: null,
      // Sem root resolvido não existe cofre canônico a consultar. Ler o cwd
      // aqui ressuscitaria estado órfão/sombra e quebraria D1/D3/INV-W4.
      memory: {
        initialized: false,
        staleness: "unknown",
        notes_count: 0,
        last_sync_at: null,
        embeddings_ready: false,
        schema_version: null,
        schema_v2_ready: false,
      },
      structural_status: { last_sync_at: null },
      ...stubResponse("falha", WORKSPACE_MISSING),
    });
  }

  const { rootPath, metadata } = resolved;
  const memory = VaultEngine.status(rootPath);

  let manifest: DiscoveryManifest | null;
  try {
    manifest = readManifest(getManifestPath(rootPath));
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
          structural_status: { last_sync_at: null },
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
      structural_status: { last_sync_at: null },
      ...stubResponse("parcial", INDEX_MISSING, {
        limitations: PARTIAL_NO_MANIFEST_LIMITATIONS,
        staleness_hint: `${STALE_RUN_INDEX}: Execute argus index para criar o manifest inicial.`,
      }),
    });
  }

  // Sincronização estrutural: `manifest.generated_at` é (re)escrito em todo
  // sync bem-sucedido (Plano 2 / P4), inclusive no-op de conteúdo. Distinto
  // do timestamp do cofre (`memory.last_sync_at`) — Plano 6 / INV-W7.
  const structural_status: StructuralStatus = {
    last_sync_at: manifest.generated_at ?? null,
  };

  let structural: StructuralIndex | null = null;
  try {
    structural = loadStructuralIndex(rootPath, "lite");
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
        structural_status,
        ...stubResponse("falha", err.message, {
          limitations: PARTIAL_CORRUPTED_STRUCTURAL_LIMITATIONS,
          staleness_hint: `${STALE_RUN_INDEX}: Execute argus index para reconstruir o índice estrutural.`,
        }),
      });
    }
    throw err;
  }

  const staleness = computeManifestStaleness(rootPath, manifest, {
    respect_gitignore: resolveRespectGitignore(metadata),
  });
  const coverage = structural?.coverage_by_language ?? {};
  const dirtyFlag = readDirtyFlag(rootPath);
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
    structural_status,
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
