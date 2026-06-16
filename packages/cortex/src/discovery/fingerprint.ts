import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { DiscoveredFile, DiscoveryManifest, FileFingerprint } from "./types.js";
import { SCHEMA_VERSION } from "../workspace/workspace.js";

export function hashFile(absolutePath: string): string {
  const content = readFileSync(absolutePath);
  return createHash("sha256").update(content).digest("hex");
}

export function fingerprintFile(file: DiscoveredFile): FileFingerprint {
  return {
    relative_path: file.relative_path,
    content_hash: hashFile(file.absolute_path),
    size_bytes: file.size_bytes,
    mtime_ms: file.mtime_ms,
  };
}

export function fingerprintDiscoveredFiles(files: DiscoveredFile[]): FileFingerprint[] {
  return files.map((file) => fingerprintFile(file));
}

export function buildDiscoveryManifest(
  rootPath: string,
  fingerprints: FileFingerprint[],
): DiscoveryManifest {
  const sortedFiles = [...fingerprints].sort((a, b) => a.relative_path.localeCompare(b.relative_path));
  return {
    schema_version: SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    root_path: rootPath,
    file_count: sortedFiles.length,
    files: sortedFiles,
  };
}
