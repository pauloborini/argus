import {
  buildDiscoveryManifest,
  fingerprintFile,
} from "../discovery/fingerprint.js";
import {
  ManifestCorruptedError,
  readManifest,
  writeManifestAtomic,
} from "../discovery/manifest.js";
import { discoverFiles } from "../discovery/walk.js";
import type { DiscoveredFile, DiscoveryManifest, FileFingerprint } from "../discovery/types.js";
import { diffManifest, planManifestSync } from "../discovery/delta.js";
import { gitDelta } from "../discovery/git-delta.js";
import { clearDirtyFlag, readDirtyFlag } from "../discovery/dirty-flag.js";
import type { DiscoveryLimitation } from "../discovery/walk.js";
import {
  buildStructuralIndex,
  updateStructuralIndexDelta,
} from "../extraction/pipeline.js";
import {
  IndexDbCorruptedError,
  IndexDbSchemaError,
  loadStructuralIndexForRead,
  persistFullStructuralIndex,
  persistStructuralIndexDelta,
} from "../storage/index-persistence.js";
import {
  getManifestPath,
  requireWorkspace,
  resolveRespectGitignore,
} from "../workspace/workspace.js";

export type SyncedVia = "full" | "git-delta" | "dirty-flag";

export interface SyncOptions {
  /** Ref git base; ativa o caminho de delta git pulando o walk completo. */
  since?: string;
  /** Força walk completo, ignorando git-delta e dirty-flag. */
  full?: boolean;
  /** Override por execução do respeito a `.gitignore` (workspace é o default). */
  respectGitignore?: boolean;
  cwd?: string;
}

interface ResolvedDelta {
  changed: DiscoveredFile[];
  removed: string[];
  limitations: DiscoveryLimitation[];
  syncedVia: SyncedVia;
  dirtyPathsConsumed: number;
}

/**
 * Reaplica um delta (changed/removed) sobre o manifest anterior, produzindo a
 * nova lista de fingerprints. Arquivos não tocados preservam o fingerprint
 * antigo (sem re-hash); só os alterados/adicionados são re-fingerprinted.
 */
function applyDeltaFingerprints(
  previousManifest: DiscoveryManifest,
  changed: DiscoveredFile[],
  removed: string[],
): FileFingerprint[] {
  const byPath = new Map(
    previousManifest.files.map((file) => [file.relative_path, file] as const),
  );
  for (const path of removed) {
    byPath.delete(path);
  }
  for (const file of changed) {
    byPath.set(file.relative_path, fingerprintFile(file));
  }
  return [...byPath.values()];
}

/**
 * Decide a estratégia de detecção de mudança e produz o delta concreto:
 *  - `--full` ou git-delta indisponível → walk completo.
 *  - `--since <ref>` → git-delta.
 *  - sem `--since`, com dirty-flag presente e git-delta resolvível pelo
 *    `since_ref` da flag → git-delta barato; senão walk.
 */
function resolveDelta(
  rootPath: string,
  previousManifest: DiscoveryManifest,
  options: SyncOptions,
  cwd: string,
  respectGitignore: boolean,
): ResolvedDelta {
  const walkPath = (): ResolvedDelta => {
    const discovery = discoverFiles(rootPath, { respect_gitignore: respectGitignore });
    const plan = planManifestSync(previousManifest, discovery.files);
    return {
      changed: [...plan.changed, ...plan.added],
      removed: plan.removed.map((file) => file.relative_path),
      limitations: discovery.limitations,
      syncedVia: "full",
      dirtyPathsConsumed: 0,
    };
  };

  if (options.full) {
    return walkPath();
  }

  if (options.since) {
    const delta = gitDelta(rootPath, options.since, { respect_gitignore: respectGitignore });
    if (delta) {
      return {
        changed: delta.changed,
        removed: delta.removed,
        limitations: delta.limitations,
        syncedVia: "git-delta",
        dirtyPathsConsumed: 0,
      };
    }
    // Fallback honesto: git ausente ou ref inválido.
    return walkPath();
  }

  const dirty = readDirtyFlag(cwd);
  const dirtyCount = dirty ? dirty.paths.length : 0;
  if (dirty && !dirty.force_full && dirty.paths.length > 0 && dirty.since_ref) {
    const delta = gitDelta(rootPath, dirty.since_ref, { respect_gitignore: respectGitignore });
    if (delta) {
      // Delta veio do consumo da dirty-flag (não de um `--since` explícito):
      // reporta `dirty-flag` como origem honesta do sync.
      return {
        changed: delta.changed,
        removed: delta.removed,
        limitations: delta.limitations,
        syncedVia: "dirty-flag",
        dirtyPathsConsumed: dirty.paths.length,
      };
    }
    // since_ref morto (rebase/gc) ou git ausente: cai no walk, mas a flag ainda
    // foi consumida — propaga o consumo para o sinal honesto não mentir.
  }

  const walked = walkPath();
  walked.dirtyPathsConsumed = dirtyCount;
  return walked;
}

export async function runSync(options: SyncOptions = {}): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  let rootPath: string;
  let respectGitignore: boolean;
  try {
    const metadata = requireWorkspace(cwd);
    rootPath = metadata.root_path;
    respectGitignore = resolveRespectGitignore(metadata, options.respectGitignore);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(message);
    return 1;
  }

  const manifestPath = getManifestPath(cwd);
  let previousManifest: DiscoveryManifest | null;
  try {
    previousManifest = readManifest(manifestPath);
  } catch (err) {
    if (err instanceof ManifestCorruptedError) {
      console.error(err.message);
      return 1;
    }
    throw err;
  }

  if (!previousManifest) {
    console.error("E_INDEX_MISSING: Índice não inicializado; execute init/index");
    return 1;
  }

  try {
    const resolved = resolveDelta(rootPath, previousManifest, options, cwd, respectGitignore);
    const nextFingerprints = applyDeltaFingerprints(
      previousManifest,
      resolved.changed,
      resolved.removed,
    );
    const delta = diffManifest(previousManifest, nextFingerprints);
    const nextManifest = buildDiscoveryManifest(rootPath, nextFingerprints);
    writeManifestAtomic(manifestPath, nextManifest);

    let previousStructural = null;
    try {
      previousStructural = loadStructuralIndexForRead(rootPath);
    } catch (err) {
      if (err instanceof IndexDbCorruptedError || err instanceof IndexDbSchemaError) {
        console.error(err.message);
        return 1;
      }
      throw err;
    }

    const viaLabel = `via ${resolved.syncedVia}`;

    if (!previousStructural) {
      const { index, summary } = await buildStructuralIndex(nextManifest, rootPath);
      persistFullStructuralIndex(rootPath, index);

      console.log(
        `Sync concluído (${viaLabel}): +${delta.added.length} / ~${delta.changed.length} / -${delta.removed.length}.`,
      );
      console.log(
        `Extração estrutural (rebuild): ${summary.files_parsed} arquivos, ${summary.symbol_count} símbolos (${summary.duration_ms}ms).`,
      );
    } else if (delta.pending_files_count > 0) {
      const changedPaths = [
        ...delta.added.map((file) => file.relative_path),
        ...delta.changed.map((file) => file.relative_path),
      ];
      const removedPaths = delta.removed.map((file) => file.relative_path);
      const { index, summary } = await updateStructuralIndexDelta(
        nextManifest,
        rootPath,
        previousStructural,
        changedPaths,
        removedPaths,
      );

      const changedSet = new Set(changedPaths);
      persistStructuralIndexDelta(rootPath, {
        manifestHash: index.manifest_hash,
        generatedAt: index.generated_at,
        coverage: index.coverage_by_language,
        extractionLimitations: index.extraction_limitations,
        upsertedFiles: index.files.filter((file) => changedSet.has(file.relative_path)),
        removedPaths,
      });

      console.log(
        `Sync concluído (${viaLabel}): +${delta.added.length} / ~${delta.changed.length} / -${delta.removed.length}.`,
      );
      console.log(
        `Extração estrutural (delta): ${summary.files_parsed} arquivos reprocessados, ${summary.symbol_count} símbolos (${summary.duration_ms}ms).`,
      );
    } else {
      console.log(`Sync concluído (${viaLabel}): índice já estava atualizado (0 alterações).`);
    }

    if (resolved.dirtyPathsConsumed > 0) {
      console.log(`Dirty-flag consumida: ${resolved.dirtyPathsConsumed} path(s) pendente(s).`);
    }
    // O sync reconciliou o estado: limpa a dirty-flag em qualquer caminho.
    clearDirtyFlag(cwd);

    if (resolved.limitations.length > 0) {
      console.warn("Sync parcial: limites de discovery atingidos.");
      for (const limitation of resolved.limitations) {
        console.warn(`- ${limitation.code}: ${limitation.path ?? "-"} ${limitation.message}`);
      }
    }

    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`E_WORKSPACE_INVALID: Falha durante sincronização: ${message}`);
    return 1;
  }
}
