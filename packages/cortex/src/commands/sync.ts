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
import { getManifestPath, requireWorkspace } from "../workspace/workspace.js";

export function runSync(): number {
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

    if (delta.pending_files_count === 0) {
      console.log("Sync concluído: índice já estava atualizado (0 alterações).");
    } else {
      console.log(
        `Sync concluído: +${delta.added.length} / ~${delta.changed.length} / -${delta.removed.length}.`,
      );
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
