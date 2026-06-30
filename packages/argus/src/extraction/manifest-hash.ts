import { createHash } from "node:crypto";
import type { DiscoveryManifest } from "../discovery/types.js";

export function computeManifestHash(manifest: DiscoveryManifest): string {
  const canonical = JSON.stringify({
    schema_version: manifest.schema_version,
    root_path: manifest.root_path,
    files: [...manifest.files]
      .sort((a, b) => a.relative_path.localeCompare(b.relative_path))
      .map((file) => ({
        relative_path: file.relative_path,
        content_hash: file.content_hash,
        size_bytes: file.size_bytes,
        mtime_ms: file.mtime_ms,
      })),
  });

  return createHash("sha256").update(canonical).digest("hex");
}
