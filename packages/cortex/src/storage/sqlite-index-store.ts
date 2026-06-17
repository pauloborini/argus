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
    // `busy_timeout`: faz um leitor (search readonly) e um escritor (sync)
    // esperarem o lock em vez de receberem SQLITE_BUSY imediato — que o catch
    // abaixo mapearia como E_INDEX_CORRUPTED e mandaria o usuário reindexar por
    // um lock transitório.
    db.pragma("busy_timeout = 5000");
    // WAL permite leitor e escritor concorrentes (índice servido durante o
    // sync). Só pode ser ativado por uma conexão de escrita; o modo persiste no
    // header do arquivo, então conexões readonly seguintes já o herdam.
    if (!options?.readonly) {
      db.pragma("journal_mode = WAL");
    }
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

  // 3 queries bulk + agrupamento em JS, em vez de 2 queries por arquivo (N+1).
  // Em repos grandes isso troca ~100k roundtrips por 3. A ordenação por
  // (file_id, …) preserva a mesma ordem intra-arquivo do código anterior.
  const symbolRows = db
    .prepare(
      "SELECT file_id, name, kind, start_line, end_line, exported FROM symbols ORDER BY file_id, start_line, name",
    )
    .all() as Array<{
    file_id: number;
    name: string;
    kind: string;
    start_line: number;
    end_line: number;
    exported: number | null;
  }>;
  const edgeRows = db
    .prepare("SELECT file_id, kind, from_symbol, target, line FROM edges ORDER BY file_id, id")
    .all() as Array<{
    file_id: number;
    kind: string;
    from_symbol: string | null;
    target: string;
    line: number | null;
  }>;

  const symbolsByFile = new Map<number, ExtractedSymbol[]>();
  for (const symbol of symbolRows) {
    const list = symbolsByFile.get(symbol.file_id) ?? [];
    list.push({
      name: symbol.name,
      kind: symbol.kind as ExtractedSymbol["kind"],
      start_line: symbol.start_line,
      end_line: symbol.end_line,
      exported: symbol.exported === null ? undefined : symbol.exported === 1,
    });
    symbolsByFile.set(symbol.file_id, list);
  }

  const edgesByFile = new Map<number, ExtractedEdge[]>();
  for (const edge of edgeRows) {
    const list = edgesByFile.get(edge.file_id) ?? [];
    list.push({
      kind: edge.kind as ExtractedEdge["kind"],
      from_symbol: edge.from_symbol ?? undefined,
      to: edge.target,
      line: edge.line ?? undefined,
    });
    edgesByFile.set(edge.file_id, list);
  }

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

    return {
      relative_path: file.relative_path,
      language: file.language as FileStructuralEntry["language"],
      symbols: symbolsByFile.get(file.id) ?? [],
      imports,
      edges: edgesByFile.get(file.id) ?? [],
      parse_errors,
    };
  });
}

/** Hidrata um FileStructuralEntry a partir da linha de `files` (símbolos/edges/imports). */
function hydrateFileEntry(
  db: Database,
  file: { id: number; relative_path: string; language: string; imports_json: string; parse_errors_json: string },
): FileStructuralEntry {
  const symbolRows = db
    .prepare(
      "SELECT name, kind, start_line, end_line, exported FROM symbols WHERE file_id = ? ORDER BY start_line, name",
    )
    .all(file.id) as Array<{
    name: string;
    kind: string;
    start_line: number;
    end_line: number;
    exported: number | null;
  }>;
  const edgeRows = db
    .prepare("SELECT kind, from_symbol, target, line FROM edges WHERE file_id = ? ORDER BY id")
    .all(file.id) as Array<{
    kind: string;
    from_symbol: string | null;
    target: string;
    line: number | null;
  }>;

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

  return {
    relative_path: file.relative_path,
    language: file.language as FileStructuralEntry["language"],
    symbols: symbolRows.map((symbol) => ({
      name: symbol.name,
      kind: symbol.kind as ExtractedSymbol["kind"],
      start_line: symbol.start_line,
      end_line: symbol.end_line,
      exported: symbol.exported === null ? undefined : symbol.exported === 1,
    })),
    imports,
    edges: edgeRows.map((edge) => ({
      kind: edge.kind as ExtractedEdge["kind"],
      from_symbol: edge.from_symbol ?? undefined,
      to: edge.target,
      line: edge.line ?? undefined,
    })),
    parse_errors,
  };
}

/** Carrega um único FileStructuralEntry por path — base do grafo lazy (sem full-load). */
export function readFileEntryByPath(db: Database, relativePath: string): FileStructuralEntry | null {
  const file = db
    .prepare(
      "SELECT id, relative_path, language, imports_json, parse_errors_json FROM files WHERE relative_path = ?",
    )
    .get(relativePath) as
    | { id: number; relative_path: string; language: string; imports_json: string; parse_errors_json: string }
    | undefined;
  return file ? hydrateFileEntry(db, file) : null;
}

/** Paths de arquivos que declaram um símbolo com este nome (resolução por nome, lazy). */
export function readSymbolFilePathsByName(db: Database, name: string): string[] {
  return (
    db
      .prepare(
        "SELECT DISTINCT f.relative_path AS relative_path FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.name = ? ORDER BY f.relative_path",
      )
      .all(name) as Array<{ relative_path: string }>
  ).map((row) => row.relative_path);
}

export interface ReverseEdgeRow {
  relative_path: string;
  kind: string;
  from_symbol: string | null;
  target: string;
  line: number | null;
}

/** Edges cujo nome-alvo normalizado bate (callers/herdeiros reversos via idx_edges_target_name). */
export function readEdgesByTargetName(db: Database, targetName: string): ReverseEdgeRow[] {
  return db
    .prepare(
      "SELECT f.relative_path AS relative_path, e.kind AS kind, e.from_symbol AS from_symbol, e.target AS target, e.line AS line FROM edges e JOIN files f ON f.id = e.file_id WHERE e.target_name = ?",
    )
    .all(targetName) as ReverseEdgeRow[];
}

/** Edges cujo target cru é exatamente este (herança reversa preserva semântica raw do eager). */
export function readEdgesByRawTarget(db: Database, target: string): ReverseEdgeRow[] {
  return db
    .prepare(
      "SELECT f.relative_path AS relative_path, e.kind AS kind, e.from_symbol AS from_symbol, e.target AS target, e.line AS line FROM edges e JOIN files f ON f.id = e.file_id WHERE e.target = ?",
    )
    .all(target) as ReverseEdgeRow[];
}

/** Quantas edges referenciam este nome-alvo (peso PageRank: referenceCount). */
export function countEdgesByTargetName(db: Database, name: string): number {
  return (
    db.prepare("SELECT COUNT(*) AS count FROM edges WHERE target_name = ?").get(name) as {
      count: number;
    }
  ).count;
}

/** Quantos símbolos têm este nome (peso PageRank: definitionCount / nome comum). */
export function countSymbolsByName(db: Database, name: string): number {
  return (
    db.prepare("SELECT COUNT(*) AS count FROM symbols WHERE name = ?").get(name) as {
      count: number;
    }
  ).count;
}

/**
 * Mapa resolved_path → arquivos que o importam. Único scan leve da coluna
 * `imports_json` (sem símbolos/edges); construído sob demanda para o lookup
 * `imported_by` reverso do grafo lazy quando não há índice de imports.
 */
export function readImportersMap(db: Database): Map<string, string[]> {
  const rows = db
    .prepare("SELECT relative_path, imports_json FROM files")
    .all() as Array<{ relative_path: string; imports_json: string }>;
  const map = new Map<string, string[]>();
  for (const row of rows) {
    let imports: ExtractedImport[];
    try {
      imports = JSON.parse(row.imports_json) as ExtractedImport[];
    } catch {
      continue;
    }
    for (const imp of imports) {
      if (!imp.resolved_path) {
        continue;
      }
      const list = map.get(imp.resolved_path);
      if (list) {
        list.push(row.relative_path);
      } else {
        map.set(imp.resolved_path, [row.relative_path]);
      }
    }
  }
  return map;
}

/** Paths para resolução de alvo de arquivo (exato + parcial por substring), lazy. */
export function readFilePathMatches(db: Database, normalizedLower: string): { exact: string[]; partial: string[] } {
  const exact = (
    db
      .prepare("SELECT relative_path FROM files WHERE LOWER(relative_path) = ? ORDER BY relative_path")
      .all(normalizedLower) as Array<{ relative_path: string }>
  ).map((row) => row.relative_path);
  const partial = (
    db
      .prepare(
        "SELECT relative_path FROM files WHERE LOWER(relative_path) LIKE ? ESCAPE '\\' ORDER BY relative_path",
      )
      .all(`%${normalizedLower.replace(/[\\%_]/g, "\\$&")}%`) as Array<{ relative_path: string }>
  ).map((row) => row.relative_path);
  return { exact, partial };
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

/**
 * Versão meta-only do índice estrutural: traz schema/coverage/limitations sem
 * materializar `files[]` (sem o N+1 de símbolos/edges por arquivo). Usada no
 * caminho quente de `search`/`files`, que não precisa do grafo completo.
 */
export function readStructuralIndexMetaFromDb(db: Database): StructuralIndex | null {
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
    files: [],
    coverage_by_language: meta.coverage_by_language,
    extraction_limitations: meta.extraction_limitations,
  };
}

export interface FileTreeRow {
  relative_path: string;
  language: string;
  has_parse_errors: boolean;
  total: number;
  functions: number;
  classes: number;
  other: number;
}

/**
 * Contagens de símbolos por arquivo agregadas em SQL (`GROUP BY file`), em vez
 * de 2 queries por arquivo + 2 JSON.parse do `readAllFileEntries`. Alimenta o
 * tree de `files` sem carregar o grafo inteiro.
 */
export function readFileTreeRows(db: Database): FileTreeRow[] {
  const rows = db
    .prepare(
      `SELECT f.relative_path AS relative_path,
              f.language AS language,
              f.parse_errors_json AS parse_errors_json,
              COALESCE(SUM(CASE WHEN s.kind = 'function' THEN 1 ELSE 0 END), 0) AS functions,
              COALESCE(SUM(CASE WHEN s.kind IN ('class', 'interface') THEN 1 ELSE 0 END), 0) AS classes,
              COALESCE(SUM(CASE WHEN s.id IS NOT NULL AND s.kind NOT IN ('function', 'class', 'interface') THEN 1 ELSE 0 END), 0) AS other,
              COUNT(s.id) AS total
       FROM files f
       LEFT JOIN symbols s ON s.file_id = f.id
       GROUP BY f.id
       ORDER BY f.relative_path`,
    )
    .all() as Array<{
    relative_path: string;
    language: string;
    parse_errors_json: string;
    functions: number;
    classes: number;
    other: number;
    total: number;
  }>;
  return rows.map((row) => ({
    relative_path: row.relative_path,
    language: row.language,
    has_parse_errors: row.parse_errors_json !== "[]" && row.parse_errors_json !== "",
    total: row.total,
    functions: row.functions,
    classes: row.classes,
    other: row.other,
  }));
}

/** Mapa path→language para um conjunto de paths (resolve cobertura por candidato). */
export function readLanguagesForPaths(db: Database, paths: string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (paths.length === 0) {
    return out;
  }
  const placeholders = paths.map(() => "?").join(",");
  const rows = db
    .prepare(`SELECT relative_path, language FROM files WHERE relative_path IN (${placeholders})`)
    .all(...paths) as Array<{ relative_path: string; language: string }>;
  for (const row of rows) {
    out.set(row.relative_path, row.language);
  }
  return out;
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
    "INSERT INTO edges (file_id, kind, from_symbol, target, target_name, line) VALUES (?, ?, ?, ?, ?, ?)",
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
      edgeTargetName(edge.to),
      edge.line ?? null,
    );
  }
}

/** Último segmento de um target cru (`obj.metodo` → `metodo`); espelha callTargetName. */
function edgeTargetName(rawTarget: string): string {
  const segments = rawTarget.split(/[.:]/).filter(Boolean);
  return segments.at(-1) ?? rawTarget;
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
