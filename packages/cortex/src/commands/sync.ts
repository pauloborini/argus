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
import type { DiscoveryManifest } from "../discovery/types.js";
import { diffManifest, planManifestSync } from "../discovery/delta.js";
import {
  readStructuralIndex,
  StructuralIndexCorruptedError,
  writeStructuralIndexAtomic,
} from "../extraction/index-store.js";
import {
  buildStructuralIndex,
  updateStructuralIndexDelta,
} from "../extraction/pipeline.js";
import {
  getManifestPath,
  getStructuralIndexPath,
  requireWorkspace,
} from "../workspace/workspace.js";

export async function runSync(): Promise<number> {
  let rootPath: string;
  try {
    const metadata = requireWorkspace();
    rootPath = metadata.root_path;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(message);
    return 1;
  }

  const manifestPath = getManifestPath(rootPath);
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
    const discovery = discoverFiles(rootPath);
    const syncPlan = planManifestSync(previousManifest, discovery.files);
    const nextFingerprints = [
      ...syncPlan.preserved,
      ...syncPlan.changed.map((file) => fingerprintFile(file)),
      ...syncPlan.added.map((file) => fingerprintFile(file)),
    ];
    const delta = diffManifest(previousManifest, nextFingerprints);
    const nextManifest = buildDiscoveryManifest(rootPath, nextFingerprints);
    writeManifestAtomic(manifestPath, nextManifest);

    const structuralPath = getStructuralIndexPath(rootPath);
    let previousStructural = null;
    try {
      previousStructural = readStructuralIndex(structuralPath);
    } catch (err) {
      if (err instanceof StructuralIndexCorruptedError) {
        console.error(err.message);
        return 1;
      }
      throw err;
    }

    if (!previousStructural) {
      const { index, summary } = await buildStructuralIndex(nextManifest, rootPath);
      writeStructuralIndexAtomic(structuralPath, index);

      console.log(
        `Sync concluído: +${delta.added.length} / ~${delta.changed.length} / -${delta.removed.length}.`,
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
      writeStructuralIndexAtomic(structuralPath, index);

      console.log(
        `Sync concluído: +${delta.added.length} / ~${delta.changed.length} / -${delta.removed.length}.`,
      );
      console.log(
        `Extração estrutural (delta): ${summary.files_parsed} arquivos reprocessados, ${summary.symbol_count} símbolos (${summary.duration_ms}ms).`,
      );
    } else {
      console.log("Sync concluído: índice já estava atualizado (0 alterações).");
    }

    if (discovery.limitations.length > 0) {
      console.warn("Sync parcial: limites de discovery atingidos.");
      for (const limitation of discovery.limitations) {
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
