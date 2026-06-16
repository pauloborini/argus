import type { DiscoveredFile, DiscoveryManifest, FileFingerprint } from "./types.js";

export interface ManifestDelta {
  added: FileFingerprint[];
  removed: FileFingerprint[];
  changed: FileFingerprint[];
  unchanged_count: number;
  pending_files_count: number;
}

export interface PlannedManifestSync {
  added: DiscoveredFile[];
  changed: DiscoveredFile[];
  preserved: FileFingerprint[];
  removed: FileFingerprint[];
  unchanged_count: number;
  pending_files_count: number;
}

export function planManifestSync(
  previousManifest: DiscoveryManifest,
  discoveredFiles: DiscoveredFile[],
): PlannedManifestSync {
  const previousMap = new Map(
    previousManifest.files.map((file) => [file.relative_path, file] as const),
  );
  const seen = new Set<string>();
  const added: DiscoveredFile[] = [];
  const changed: DiscoveredFile[] = [];
  const preserved: FileFingerprint[] = [];

  for (const file of discoveredFiles) {
    seen.add(file.relative_path);
    const previous = previousMap.get(file.relative_path);

    if (!previous) {
      added.push(file);
      continue;
    }

    if (previous.size_bytes === file.size_bytes && previous.mtime_ms === file.mtime_ms) {
      preserved.push(previous);
      continue;
    }

    changed.push(file);
  }

  const removed = previousManifest.files.filter((file) => !seen.has(file.relative_path));

  return {
    added,
    changed,
    preserved,
    removed,
    unchanged_count: preserved.length,
    pending_files_count: added.length + changed.length + removed.length,
  };
}

export function diffManifest(
  previousManifest: DiscoveryManifest,
  nextFiles: FileFingerprint[],
): ManifestDelta {
  const previousMap = new Map(
    previousManifest.files.map((file) => [file.relative_path, file] as const),
  );
  const nextMap = new Map(nextFiles.map((file) => [file.relative_path, file] as const));

  const added: FileFingerprint[] = [];
  const changed: FileFingerprint[] = [];
  let unchangedCount = 0;

  for (const file of nextFiles) {
    const previous = previousMap.get(file.relative_path);
    if (!previous) {
      added.push(file);
      continue;
    }

    const sameContent =
      previous.content_hash === file.content_hash &&
      previous.size_bytes === file.size_bytes &&
      previous.mtime_ms === file.mtime_ms;

    if (sameContent) {
      unchangedCount += 1;
    } else {
      changed.push(file);
    }
  }

  const removed = previousManifest.files.filter((file) => !nextMap.has(file.relative_path));

  return {
    added,
    removed,
    changed,
    unchanged_count: unchangedCount,
    pending_files_count: added.length + removed.length + changed.length,
  };
}
