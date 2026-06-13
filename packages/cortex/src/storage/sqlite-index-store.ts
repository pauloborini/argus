import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  ExtractedEdge,
  ExtractedImport,
  ExtractedSymbol,
  FileStructuralEntry,
  LanguageCoverage,
  ParseError,
  StructuralIndex,
} from "../extraction/types.js";
import type { Database } from "./sqlite-db.js";
import {
  IndexDbCorruptedError,
  IndexDbSchemaError,
  loadBetterSqlite3,
} from "./sqlite-db.js";
import { assertCompatibleIndexSchema, applyMigrations } from "./sqlite-schema.js";
import { SQLITE_SCHEMA_VERSION } from "./sqlite-prepared.js";

export interface IndexMeta {
  schema_version: string;
  generated_at: string;
  manifest_hash: string;
  file_count: number;
  symbol_count: number;
  coverage_by_language: Record<string, LanguageCoverage>;
  extraction_limitations?: string[];
  migration_source?: string;
}

export interface IndexDelta {
  manifestHash: string;
  generatedAt: string;
  coverage: Record<string, LanguageCoverage>;
  extractionLimitations?: string[];
  upsertedFiles: FileStructuralEntry[];
  removedPaths: string[];
  migrationSource?: string;
}

export interface FtsSearchHit {
  symbol_id: number;
  name: string;
  relative_path: string;
  kind: string;
  start_line: number;
  end_line: number;
  rank: number;
}

export { IndexDbCorruptedError, IndexDbSchemaError };

export function openIndexDb(dbPath: string, options?: { readonly?: boolean }): Database {
  const BetterSqlite3 = loadBetterSqlite3();
  if (!options?.readonly) {
    mkdirSync(dirname(dbPath), { recursive: true });
  } else if (!existsSync(dbPath)) {
    throw new IndexDbCorruptedError(
      "E_INDEX_MISSING: Índice SQLite ausente; execute cortex index para gerar .cortex/index.db.",
    );
  }

  let db: Database;
  try {
    db = new BetterSqlite3(dbPath, { readonly: options?.readonly ?? false });
    db.pragma("foreign_keys = ON");
    applyMigrations(db);
    assertCompatibleIndexSchema(db);
  } catch (err) {
    if (err instanceof IndexDbSchemaError || err instanceof IndexDbCorruptedError) {
      throw err;
    }
    throw new IndexDbCorruptedError(
      "E_INDEX_CORRUPTED: Banco SQLite ilegível ou corrompido; execute cortex index para reconstruir.",
    );
  }

  return db;
}

export function closeIndexDb(db: Database): void {
  db.close();
}

export function isIndexDbPopulated(db: Database): boolean {
  const row = db.prepare("SELECT 1 AS ok FROM index_meta WHERE id = 1").get();
  return row !== undefined;
}

export function replaceFullIndex(
  db: Database,
  index: StructuralIndex,
  options?: { migrationSource?: string },
): void {
  const tx = db.transaction(() => {
    db.exec("DELETE FROM symbols_fts");
    db.exec("DELETE FROM edges");
    db.exec("DELETE FROM symbols");
    db.exec("DELETE FROM files");
    db.exec("DELETE FROM index_meta");

    for (const file of index.files) {
      insertFileEntry(db, file);
    }

    writeIndexMeta(db, {
      schema_version: index.schema_version,
      generated_at: index.generated_at,
      manifest_hash: index.manifest_hash,
      file_count: index.file_count,
      symbol_count: index.symbol_count,
      coverage_by_language: index.coverage_by_language,
      extraction_limitations: index.extraction_limitations,
      migration_source: options?.migrationSource,
    });
  });

  tx();
}

export function applyDelta(db: Database, delta: IndexDelta): void {
  const tx = db.transaction(() => {
    for (const removedPath of delta.removedPaths) {
      deleteFileByPath(db, removedPath);
    }

    for (const file of delta.upsertedFiles) {
      deleteFileByPath(db, file.relative_path);
      insertFileEntry(db, file);
    }

    const meta = readIndexMeta(db);
    const fileCount = (
      db.prepare("SELECT COUNT(*) AS count FROM files").get() as { count: number }
    ).count;
    const symbolCount = (
      db.prepare("SELECT COUNT(*) AS count FROM symbols").get() as { count: number }
    ).count;

    writeIndexMeta(db, {
      schema_version: meta?.schema_version ?? SQLITE_SCHEMA_VERSION,
      generated_at: delta.generatedAt,
      manifest_hash: delta.manifestHash,
      file_count: fileCount,
      symbol_count: symbolCount,
      coverage_by_language: delta.coverage,
      extraction_limitations: delta.extractionLimitations,
      migration_source: delta.migrationSource ?? meta?.migration_source,
    });
  });

  tx();
}

export function readIndexMeta(db: Database): IndexMeta | null {
  const row = db
    .prepare(
      `SELECT schema_version, generated_at, manifest_hash, file_count, symbol_count,
              coverage_by_language_json, extraction_limitations_json, migration_source
       FROM index_meta WHERE id = 1`,
    )
    .get() as
    | {
        schema_version: string;
        generated_at: string;
        manifest_hash: string;
        file_count: number;
        symbol_count: number;
        coverage_by_language_json: string;
        extraction_limitations_json: string | null;
        migration_source: string | null;
      }
    | undefined;

  if (!row) {
    return null;
  }

  try {
    return {
      schema_version: row.schema_version,
      generated_at: row.generated_at,
      manifest_hash: row.manifest_hash,
      file_count: row.file_count,
      symbol_count: row.symbol_count,
      coverage_by_language: JSON.parse(row.coverage_by_language_json) as Record<
        string,
        LanguageCoverage
      >,
      extraction_limitations: row.extraction_limitations_json
        ? (JSON.parse(row.extraction_limitations_json) as string[])
        : undefined,
      migration_source: row.migration_source ?? undefined,
    };
  } catch {
    throw new IndexDbCorruptedError(
      "E_INDEX_CORRUPTED: Metadados do índice SQLite ilegíveis; execute cortex index para reconstruir.",
    );
  }
}

export function readCoverageByLanguage(
  db: Database,
): Record<string, LanguageCoverage> {
  return readIndexMeta(db)?.coverage_by_language ?? {};
}

export function readAllFileEntries(db: Database): FileStructuralEntry[] {
  const files = db
    .prepare("SELECT id, relative_path, language, imports_json, parse_errors_json FROM files ORDER BY relative_path")
    .all() as Array<{
    id: number;
    relative_path: string;
    language: string;
    imports_json: string;
    parse_errors_json: string;
  }>;

  const symbolsStmt = db.prepare(
    "SELECT name, kind, start_line, end_line, exported FROM symbols WHERE file_id = ? ORDER BY start_line, name",
  );
  const edgesStmt = db.prepare(
    "SELECT kind, from_symbol, target, line FROM edges WHERE file_id = ? ORDER BY id",
  );

  return files.map((file) => {
    let imports: ExtractedImport[];
    let parse_errors: ParseError[];
    try {
      imports = JSON.parse(file.imports_json) as ExtractedImport[];
      parse_errors = JSON.parse(file.parse_errors_json) as ParseError[];
    } catch {
      throw new IndexDbCorruptedError(
        "E_INDEX_CORRUPTED: Dados de arquivo corrompidos no SQLite; execute cortex index para reconstruir.",
      );
    }

    const symbols = symbolsStmt.all(file.id) as Array<{
      name: string;
      kind: string;
      start_line: number;
      end_line: number;
      exported: number | null;
    }>;
    const edges = (
      edgesStmt.all(file.id) as Array<{
        kind: string;
        from_symbol: string | null;
        target: string;
        line: number | null;
      }>
    ).map((edge) => ({
      kind: edge.kind as ExtractedEdge["kind"],
      from_symbol: edge.from_symbol ?? undefined,
      to: edge.target,
      line: edge.line ?? undefined,
    }));

    return {
      relative_path: file.relative_path,
      language: file.language as FileStructuralEntry["language"],
      symbols: symbols.map((symbol) => ({
        name: symbol.name,
        kind: symbol.kind as ExtractedSymbol["kind"],
        start_line: symbol.start_line,
        end_line: symbol.end_line,
        exported: symbol.exported === null ? undefined : symbol.exported === 1,
      })),
      imports,
      edges,
      parse_errors,
    };
  });
}

export function readStructuralIndexFromDb(db: Database): StructuralIndex | null {
  const meta = readIndexMeta(db);
  if (!meta) {
    return null;
  }

  return {
    schema_version: meta.schema_version,
    generated_at: meta.generated_at,
    manifest_hash: meta.manifest_hash,
    file_count: meta.file_count,
    symbol_count: meta.symbol_count,
    files: readAllFileEntries(db),
    coverage_by_language: meta.coverage_by_language,
    extraction_limitations: meta.extraction_limitations,
  };
}

export function readFilesTree(db: Database): FileStructuralEntry[] {
  return readAllFileEntries(db);
}

export function searchFtsInternal(
  db: Database,
  query: string,
  limit = 50,
  filters?: { scope?: string; kind?: string },
): FtsSearchHit[] {
  const sanitized = query.trim();
  if (!sanitized) {
    return [];
  }
  const scope = filters?.scope?.trim().toLowerCase();
  const kind = filters?.kind?.trim().toLowerCase();
  const filterSql = `${scope ? " AND lower(f.relative_path) LIKE ?" : ""}${
    kind ? " AND lower(s.kind) = ?" : ""
  }`;
  const filterParams = [
    ...(scope ? [`%${scope}%`] : []),
    ...(kind ? [kind] : []),
  ];

  const ftsQuery = sanitized
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => `"${token.replaceAll('"', '""')}"`)
    .join(" ");

  if (!ftsQuery) {
    return [];
  }

  const ftsRows = db
    .prepare(
      `SELECT s.id AS symbol_id, s.name, f.relative_path, s.kind,
              s.start_line, s.end_line, bm25(symbols_fts) AS rank
       FROM symbols_fts
       JOIN symbols s ON s.id = symbols_fts.rowid
       JOIN files f ON f.id = s.file_id
       WHERE symbols_fts MATCH ?${filterSql}
       ORDER BY rank
       LIMIT ?`,
    )
    .all(ftsQuery, ...filterParams, limit) as FtsSearchHit[];

  const like = `%${sanitized.toLowerCase()}%`;
  const lexicalRows = db
    .prepare(
      `SELECT s.id AS symbol_id, s.name, f.relative_path, s.kind,
              s.start_line, s.end_line, 0 AS rank
       FROM symbols s
       JOIN files f ON f.id = s.file_id
       WHERE (lower(s.name) LIKE ? OR lower(f.relative_path) LIKE ? OR lower(s.kind) = ?)
         ${filterSql}
       ORDER BY
         CASE
           WHEN lower(s.name) = ? THEN 0
           WHEN lower(s.name) LIKE ? THEN 1
           WHEN lower(s.name) LIKE ? THEN 2
           WHEN lower(f.relative_path) LIKE ? THEN 3
           ELSE 4
         END,
         length(s.name),
         f.relative_path
       LIMIT ?`,
    )
    .all(
      like,
      like,
      sanitized.toLowerCase(),
      ...filterParams,
      sanitized.toLowerCase(),
      `${sanitized.toLowerCase()}%`,
      like,
      like,
      limit,
    ) as FtsSearchHit[];

  const byId = new Map<number, FtsSearchHit>();
  for (const hit of [...lexicalRows, ...ftsRows]) {
    if (!byId.has(hit.symbol_id)) {
      byId.set(hit.symbol_id, hit);
    }
  }
  return Array.from(byId.values()).slice(0, limit);
}

function writeIndexMeta(db: Database, meta: IndexMeta): void {
  db.prepare(
    `INSERT INTO index_meta (
      id, schema_version, generated_at, manifest_hash, file_count, symbol_count,
      coverage_by_language_json, extraction_limitations_json, migration_source
    ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      schema_version = excluded.schema_version,
      generated_at = excluded.generated_at,
      manifest_hash = excluded.manifest_hash,
      file_count = excluded.file_count,
      symbol_count = excluded.symbol_count,
      coverage_by_language_json = excluded.coverage_by_language_json,
      extraction_limitations_json = excluded.extraction_limitations_json,
      migration_source = excluded.migration_source`,
  ).run(
    meta.schema_version,
    meta.generated_at,
    meta.manifest_hash,
    meta.file_count,
    meta.symbol_count,
    JSON.stringify(meta.coverage_by_language),
    meta.extraction_limitations ? JSON.stringify(meta.extraction_limitations) : null,
    meta.migration_source ?? null,
  );
}

function insertFileEntry(db: Database, file: FileStructuralEntry): void {
  const result = db
    .prepare(
      "INSERT INTO files (relative_path, language, imports_json, parse_errors_json) VALUES (?, ?, ?, ?)",
    )
    .run(
      file.relative_path,
      file.language,
      JSON.stringify(file.imports),
      JSON.stringify(file.parse_errors),
    );

  const fileId = Number(result.lastInsertRowid);
  const insertSymbol = db.prepare(
    "INSERT INTO symbols (file_id, name, kind, start_line, end_line, exported) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const insertEdge = db.prepare(
    "INSERT INTO edges (file_id, kind, from_symbol, target, line) VALUES (?, ?, ?, ?, ?)",
  );
  const insertFts = db.prepare(
    "INSERT INTO symbols_fts (rowid, name, relative_path, kind) VALUES (?, ?, ?, ?)",
  );

  for (const symbol of file.symbols) {
    const symbolResult = insertSymbol.run(
      fileId,
      symbol.name,
      symbol.kind,
      symbol.start_line,
      symbol.end_line,
      symbol.exported === undefined ? null : symbol.exported ? 1 : 0,
    );
    const symbolId = Number(symbolResult.lastInsertRowid);
    insertFts.run(symbolId, symbol.name, file.relative_path, symbol.kind);
  }

  for (const edge of file.edges) {
    insertEdge.run(
      fileId,
      edge.kind,
      edge.from_symbol ?? null,
      edge.to,
      edge.line ?? null,
    );
  }
}

function deleteFileByPath(db: Database, relativePath: string): void {
  const file = db
    .prepare("SELECT id FROM files WHERE relative_path = ?")
    .get(relativePath) as { id: number } | undefined;

  if (!file) {
    return;
  }

  const symbolIds = db
    .prepare("SELECT id FROM symbols WHERE file_id = ?")
    .all(file.id) as Array<{ id: number }>;

  const deleteFts = db.prepare("DELETE FROM symbols_fts WHERE rowid = ?");
  for (const { id } of symbolIds) {
    deleteFts.run(id);
  }

  db.prepare("DELETE FROM files WHERE id = ?").run(file.id);
}
