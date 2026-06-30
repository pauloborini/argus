/** Tipos compartilhados para discovery/fingerprint (S04+) */

export interface DiscoveredFile {
  relative_path: string;
  absolute_path: string;
  size_bytes: number;
  mtime_ms: number;
}

export interface FileFingerprint {
  relative_path: string;
  content_hash: string;
  size_bytes: number;
  mtime_ms: number;
}

export interface DiscoveryManifest {
  schema_version: string;
  generated_at: string;
  root_path: string;
  file_count: number;
  files: FileFingerprint[];
}
