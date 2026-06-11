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
    if (discovery.limitations.length > 0) {
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
