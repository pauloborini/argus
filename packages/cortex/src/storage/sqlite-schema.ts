import type { Database } from "./sqlite-db.js";
import { IndexDbSchemaError } from "./sqlite-db.js";
import { SQLITE_SCHEMA_VERSION } from "./sqlite-prepared.js";

export const MIGRATION_VERSION = 3;

/** Último segmento de um target cru (`obj.metodo` → `metodo`); espelha callTargetName. */
function targetLastSegment(rawTarget: string): string {
  const segments = rawTarget.split(/[.:]/).filter(Boolean);
  return segments.at(-1) ?? rawTarget;
}

const DDL_V1 = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS index_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  schema_version TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  manifest_hash TEXT NOT NULL,
  file_count INTEGER NOT NULL,
  symbol_count INTEGER NOT NULL,
  coverage_by_language_json TEXT NOT NULL,
  extraction_limitations_json TEXT,
  migration_source TEXT
);

CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  relative_path TEXT NOT NULL UNIQUE,
  language TEXT NOT NULL,
  imports_json TEXT NOT NULL DEFAULT '[]',
  parse_errors_json TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS symbols (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  exported INTEGER
);

CREATE INDEX IF NOT EXISTS idx_symbols_file_id ON symbols(file_id);
CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);

CREATE TABLE IF NOT EXISTS edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  from_symbol TEXT,
  target TEXT NOT NULL,
  line INTEGER
);

CREATE INDEX IF NOT EXISTS idx_edges_file_id ON edges(file_id);

CREATE TABLE IF NOT EXISTS packed_handles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  handle TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(
  name,
  relative_path,
  kind,
  tokenize='unicode61'
);
`;

// v2: índices para travessia do grafo por query (trace/impact em SQL, sem
// reconstruir o grafo inteiro em JS). `edges(target)` resolve callers/herdeiros;
// `edges(from_symbol)` resolve as edges de um símbolo dono.
const DDL_V2 = `
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target);
CREATE INDEX IF NOT EXISTS idx_edges_from_symbol ON edges(from_symbol);
`;

// v3: coluna derivada `target_name` (último segmento de `target`) + índice,
// habilita lookup reverso por nome (called_by/extends_by) em SQL sem varrer
// `target` cru. ADD COLUMN roda uma única vez (gated por appliedVersion); o
// backfill repopula DBs existentes sem exigir reindex.
const DDL_V3 = `
ALTER TABLE edges ADD COLUMN target_name TEXT;
CREATE INDEX IF NOT EXISTS idx_edges_target_name ON edges(target_name);
`;

/** Repopula target_name de DBs já existentes (edges gravadas antes da v3). */
export function backfillTargetName(db: Database): void {
  const rows = db.prepare("SELECT id, target FROM edges WHERE target_name IS NULL").all() as Array<{
    id: number;
    target: string;
  }>;
  const update = db.prepare("UPDATE edges SET target_name = ? WHERE id = ?");
  for (const row of rows) {
    update.run(targetLastSegment(row.target), row.id);
  }
}

/** Ladder de migrações: cada degrau é idempotente; `backfill` roda pós-DDL. */
const MIGRATIONS: ReadonlyArray<{ version: number; ddl: string; backfill?: (db: Database) => void }> = [
  { version: 1, ddl: DDL_V1 },
  { version: 2, ddl: DDL_V2 },
  { version: 3, ddl: DDL_V3, backfill: backfillTargetName },
];

function hasMigrationsTable(db: Database): boolean {
  const row = db
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .get();
  return row !== undefined;
}

export function applyMigrations(db: Database): void {
  db.pragma("foreign_keys = ON");

  // DBs antigos (pré-ladder) gravavam só a versão final sem rodar os degraus
  // intermediários; CREATE … IF NOT EXISTS torna re-rodar barato e seguro.
  const appliedVersion = hasMigrationsTable(db)
    ? ((
        db
          .prepare("SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1")
          .get() as { version: number } | undefined
      )?.version ?? 0)
    : 0;

  if (appliedVersion > MIGRATION_VERSION) {
    throw new IndexDbSchemaError(
      `E_INDEX_SCHEMA_INCOMPATIBLE: Schema do banco (v${appliedVersion}) é mais novo que o runtime; atualize o pacote cortex.`,
    );
  }

  // A tabela schema_migrations só existe após o DDL_V1; por isso o INSERT é
  // preparado dentro do loop (pós-exec), não antes.
  const runLadder = db.transaction(() => {
    for (const migration of MIGRATIONS) {
      if (migration.version > appliedVersion) {
        db.exec(migration.ddl);
        migration.backfill?.(db);
        db.prepare(
          "INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)",
        ).run(migration.version, new Date().toISOString());
      }
    }
  });
  runLadder();
}

export function assertCompatibleIndexSchema(db: Database): void {
  const meta = db
    .prepare("SELECT schema_version FROM index_meta WHERE id = 1")
    .get() as { schema_version: string } | undefined;

  if (!meta) {
    return;
  }

  if (meta.schema_version !== SQLITE_SCHEMA_VERSION) {
    throw new IndexDbSchemaError(
      `E_INDEX_SCHEMA_INCOMPATIBLE: Schema do índice (${meta.schema_version}) incompatível com runtime (${SQLITE_SCHEMA_VERSION}); execute cortex index para reconstruir.`,
    );
  }
}
