import type { Database } from "./sqlite-db.js";
import {
  MEMORY_V2_NOTE_EXTENSION_FIELD_NAMES,
  type MemoryV2NoteExtension,
} from "../v2-persistence-draft.js";
import { MEMORY_SQLITE_SCHEMA_VERSION } from "./sqlite-schema.js";

export const MEMORY_SQLITE_SCHEMA_VERSION_V1 = "1.0.0";

/** Colunas v2 com defaults seguros para ALTER idempotente (PRD D2). */
export const MEMORY_V2_COLUMN_DEFS: ReadonlyArray<{
  name: keyof MemoryV2NoteExtension;
  sql: string;
}> = [
  { name: "scope", sql: "scope TEXT NOT NULL DEFAULT 'project'" },
  { name: "source", sql: "source TEXT NOT NULL DEFAULT 'v1_migration'" },
  { name: "confidence", sql: "confidence TEXT NOT NULL DEFAULT 'presumed'" },
  { name: "observed_at", sql: "observed_at TEXT" },
  { name: "valid_from", sql: "valid_from TEXT" },
  { name: "valid_until", sql: "valid_until TEXT" },
  { name: "superseded_by", sql: "superseded_by TEXT" },
  { name: "supersedes", sql: "supersedes TEXT" },
  { name: "stale_reason", sql: "stale_reason TEXT" },
  { name: "contradiction_reason", sql: "contradiction_reason TEXT" },
  { name: "migrated_from_v1", sql: "migrated_from_v1 TEXT" },
];

function notesColumnNames(db: Database): Set<string> {
  const rows = db.prepare("PRAGMA table_info(notes)").all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

function readSchemaVersion(db: Database): string | null {
  try {
    const row = db.prepare("SELECT schema_version FROM memory_meta WHERE id = 1").get() as
      | { schema_version: string }
      | undefined;
    return row?.schema_version ?? null;
  } catch {
    return null;
  }
}

/** SQL de schema v1 para fixtures de teste. */
export function memoryV1SchemaSql(): string {
  return `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS memory_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  schema_version TEXT NOT NULL,
  last_sync_at TEXT,
  notes_count INTEGER NOT NULL DEFAULT 0,
  vault_hash TEXT
);

CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  type TEXT NOT NULL,
  tags_json TEXT NOT NULL DEFAULT '[]',
  links_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT,
  updated_at TEXT,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
  note_id UNINDEXED,
  path,
  title,
  content
);

CREATE TABLE IF NOT EXISTS note_embeddings (
  note_id TEXT PRIMARY KEY,
  vector BLOB NOT NULL,
  scale REAL NOT NULL,
  dim INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  FOREIGN KEY(note_id) REFERENCES notes(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS note_embeddings_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  model TEXT NOT NULL,
  dim INTEGER NOT NULL,
  built_at TEXT NOT NULL,
  note_count INTEGER NOT NULL,
  vault_hash TEXT
);

CREATE INDEX IF NOT EXISTS idx_notes_path ON notes(path);
CREATE INDEX IF NOT EXISTS idx_notes_type ON notes(type);
`;
}

/**
 * Migração forward-only e idempotente v1→v2 (PRD D2/D5).
 * Chamada apenas em `openMemoryDb` modo write.
 */
export function migrateMemoryDbToV2(db: Database): void {
  const existing = notesColumnNames(db);
  const hasAllV2 = MEMORY_V2_COLUMN_DEFS.every((col) => existing.has(col.name));
  const current = readSchemaVersion(db);
  if (current === MEMORY_SQLITE_SCHEMA_VERSION && hasAllV2) {
    return;
  }

  const tx = db.transaction(() => {
    const existing = notesColumnNames(db);
    for (const col of MEMORY_V2_COLUMN_DEFS) {
      if (!existing.has(col.name)) {
        db.exec(`ALTER TABLE notes ADD COLUMN ${col.sql}`);
      }
    }

    db.prepare(
      `UPDATE notes SET
         migrated_from_v1 = COALESCE(migrated_from_v1, path),
         source = CASE WHEN source = 'v1_migration' OR source IS NULL OR source = '' THEN 'v1_migration' ELSE source END,
         scope = COALESCE(NULLIF(scope, ''), 'project'),
         confidence = COALESCE(NULLIF(confidence, ''), 'presumed'),
         observed_at = COALESCE(observed_at, updated_at, created_at, datetime('now'))
       WHERE migrated_from_v1 IS NULL OR observed_at IS NULL`,
    ).run();

    db.prepare(
      `INSERT INTO memory_meta (id, schema_version, notes_count)
       VALUES (1, ?, COALESCE((SELECT notes_count FROM memory_meta WHERE id = 1), 0))
       ON CONFLICT(id) DO UPDATE SET schema_version = excluded.schema_version`,
    ).run(MEMORY_SQLITE_SCHEMA_VERSION);
  });
  tx();
}

export function isMemorySchemaV2(db: Database): boolean {
  return readSchemaVersion(db) === MEMORY_SQLITE_SCHEMA_VERSION;
}

export const MEMORY_V2_NOTE_INSERT_COLUMNS = [
  "id",
  "path",
  "title",
  "type",
  "tags_json",
  "links_json",
  "created_at",
  "updated_at",
  "content",
  "content_hash",
  ...MEMORY_V2_NOTE_EXTENSION_FIELD_NAMES,
] as const;

export function memoryV2NoteInsertSql(): string {
  const cols = MEMORY_V2_NOTE_INSERT_COLUMNS.join(", ");
  const placeholders = MEMORY_V2_NOTE_INSERT_COLUMNS.map(() => "?").join(", ");
  return `INSERT INTO notes (${cols}) VALUES (${placeholders})`;
}
