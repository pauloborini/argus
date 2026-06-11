import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { DiscoveryManifest, FileFingerprint } from "./types.js";

export class ManifestCorruptedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestCorruptedError";
  }
}

function isValidManifestFile(file: unknown): file is FileFingerprint {
  if (!file || typeof file !== "object") {
    return false;
  }

  const candidate = file as Partial<FileFingerprint>;
  return (
    typeof candidate.relative_path === "string" &&
    typeof candidate.content_hash === "string" &&
    typeof candidate.size_bytes === "number" &&
    Number.isFinite(candidate.size_bytes) &&
    typeof candidate.mtime_ms === "number" &&
    Number.isFinite(candidate.mtime_ms)
  );
}

function isManifestLike(value: unknown): value is DiscoveryManifest {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<DiscoveryManifest>;
  return (
    typeof candidate.schema_version === "string" &&
    typeof candidate.generated_at === "string" &&
    typeof candidate.root_path === "string" &&
    typeof candidate.file_count === "number" &&
    Array.isArray(candidate.files) &&
    candidate.files.every((file) => isValidManifestFile(file))
  );
}

export function readManifest(manifestPath: string): DiscoveryManifest | null {
  if (!existsSync(manifestPath)) {
    return null;
  }

  try {
    const raw = readFileSync(manifestPath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isManifestLike(parsed)) {
      throw new ManifestCorruptedError(
        "E_INDEX_CORRUPTED: Manifest corrompido ou inválido; execute cortex index para recriar o inventário.",
      );
    }
    return parsed;
  } catch (err) {
    if (err instanceof ManifestCorruptedError) {
      throw err;
    }
    throw new ManifestCorruptedError(
      "E_INDEX_CORRUPTED: Manifest ilegível; execute cortex index para recriar o inventário.",
    );
  }
}

export function writeManifestAtomic(manifestPath: string, manifest: DiscoveryManifest): void {
  mkdirSync(dirname(manifestPath), { recursive: true });
  const tempPath = `${manifestPath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempPath, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
  renameSync(tempPath, manifestPath);
}
