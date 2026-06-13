import type { DiscoveryManifest } from "./types.js";
import { discoverFiles } from "./walk.js";

export type ManifestStaleness = "fresh" | "stale" | "unknown";

export interface StalenessResult {
  staleness: ManifestStaleness;
  pending_files_count: number;
}

export function computeManifestStaleness(
  rootPath: string,
  manifest: DiscoveryManifest,
): StalenessResult {
  try {
    const discovery = discoverFiles(rootPath);
    // Só limitações que comprometem a integridade da comparação geram "unknown".
    // MAX_FILE_SIZE é exclusão determinística e simétrica: o mesmo arquivo grande
    // é omitido na indexação e no recheck (todos usam discoverFiles com o mesmo
    // cap), logo nunca entra no manifest e não introduz incerteza. Tratá-lo como
    // "unknown" zerava staleness — e, por consequência, search — em qualquer repo
    // real com um único arquivo >2MB (lockfile, código gerado, asset).
    // READ_ERROR (não conseguimos ler) e MAX_FILE_COUNT (discovery truncado)
    // sim comprometem a comparação e permanecem "unknown".
    const blockingLimitations = discovery.limitations.filter(
      (limitation) => limitation.code !== "MAX_FILE_SIZE",
    );
    if (blockingLimitations.length > 0) {
      return {
        staleness: "unknown",
        pending_files_count: 0,
      };
    }

    const discoveredMap = new Map(
      discovery.files.map((file) => [file.relative_path, file] as const),
    );
    const manifestMap = new Map(
      manifest.files.map((file) => [file.relative_path, file] as const),
    );

    let pending = 0;

    for (const file of discovery.files) {
      const previous = manifestMap.get(file.relative_path);
      if (!previous) {
        pending += 1;
        continue;
      }
      if (previous.size_bytes !== file.size_bytes || previous.mtime_ms !== file.mtime_ms) {
        pending += 1;
      }
    }

    for (const file of manifest.files) {
      if (!discoveredMap.has(file.relative_path)) {
        pending += 1;
      }
    }

    return {
      staleness: pending > 0 ? "stale" : "fresh",
      pending_files_count: pending,
    };
  } catch {
    return {
      staleness: "unknown",
      pending_files_count: 0,
    };
  }
}
