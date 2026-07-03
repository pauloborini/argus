export const MEMORY_SQLITE_SCHEMA_VERSION = "2.0.0";

export function memorySchemaSql(): string {
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
  content_hash TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'project',
  source TEXT NOT NULL DEFAULT 'v1_migration',
  confidence TEXT NOT NULL DEFAULT 'presumed',
  observed_at TEXT,
  valid_from TEXT,
  valid_until TEXT,
  superseded_by TEXT,
  supersedes TEXT,
  stale_reason TEXT,
  contradiction_reason TEXT,
  migrated_from_v1 TEXT
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

CREATE TABLE IF NOT EXISTS memory_entities (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('note', 'tag', 'path', 'symbol')),
  canonical_key TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  UNIQUE (kind, canonical_key)
);

CREATE TABLE IF NOT EXISTS memory_relations (
  id TEXT PRIMARY KEY,
  source_note_id TEXT NOT NULL,
  target_entity_id TEXT NOT NULL,
  mechanism TEXT NOT NULL,
  confidence TEXT NOT NULL,
  evidence TEXT NOT NULL,
  FOREIGN KEY (source_note_id) REFERENCES notes(id) ON DELETE CASCADE,
  FOREIGN KEY (target_entity_id) REFERENCES memory_entities(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_notes_path ON notes(path);
CREATE INDEX IF NOT EXISTS idx_notes_type ON notes(type);
CREATE INDEX IF NOT EXISTS idx_memory_entities_kind_key ON memory_entities(kind, canonical_key);
CREATE INDEX IF NOT EXISTS idx_memory_relations_source ON memory_relations(source_note_id);
CREATE INDEX IF NOT EXISTS idx_memory_relations_target ON memory_relations(target_entity_id);
`;
}
