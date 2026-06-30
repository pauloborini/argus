// Persistência dos vetores de embedding (tabelas v4). Mantida separada do
// sqlite-index-store estrutural: embeddings são opcionais e off-by-default.
import type { Database } from "./sqlite-db.js";
import { blobToInt8, int8ToBlob } from "../embeddings/quantize.js";
import type { EmbeddingRow } from "../embeddings/vector-search.js";

export interface EmbeddingInsert {
  symbol_id: number;
  bytes: Int8Array;
  scale: number;
  content_hash: string;
}

export interface EmbeddingsMeta {
  model: string;
  dim: number;
  built_at: string;
  symbol_count: number;
  manifest_hash: string;
}

/** Símbolo + path + range para gerar o texto do chunk a embeddar. */
export interface SymbolForEmbedding {
  symbol_id: number;
  name: string;
  kind: string;
  start_line: number;
  end_line: number;
  relative_path: string;
}

/** Símbolo resolvido a partir de um symbol_id (para montar SearchCandidate). */
export interface SymbolDetail {
  symbol_id: number;
  name: string;
  kind: string;
  start_line: number;
  end_line: number;
  relative_path: string;
}

export function hasEmbeddings(db: Database): boolean {
  const row = db.prepare("SELECT 1 AS ok FROM embeddings LIMIT 1").get();
  return row !== undefined;
}

export function readEmbeddingsMeta(db: Database): EmbeddingsMeta | null {
  const row = db
    .prepare(
      "SELECT model, dim, built_at, symbol_count, manifest_hash FROM embeddings_meta WHERE id = 1",
    )
    .get() as EmbeddingsMeta | undefined;
  return row ?? null;
}

/** Lê todos os símbolos com path/range para a fase de geração de embeddings. */
export function readSymbolsForEmbedding(db: Database): SymbolForEmbedding[] {
  return db
    .prepare(
      `SELECT s.id AS symbol_id, s.name, s.kind, s.start_line, s.end_line,
              f.relative_path
       FROM symbols s
       JOIN files f ON f.id = s.file_id
       ORDER BY f.relative_path, s.start_line`,
    )
    .all() as SymbolForEmbedding[];
}

/** Resolve detalhes de símbolos a partir de ids (top-K denso → candidatos). */
export function readSymbolsByIds(db: Database, ids: number[]): Map<number, SymbolDetail> {
  const result = new Map<number, SymbolDetail>();
  if (ids.length === 0) {
    return result;
  }
  const placeholders = ids.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT s.id AS symbol_id, s.name, s.kind, s.start_line, s.end_line,
              f.relative_path
       FROM symbols s
       JOIN files f ON f.id = s.file_id
       WHERE s.id IN (${placeholders})`,
    )
    .all(...ids) as SymbolDetail[];
  for (const row of rows) {
    result.set(row.symbol_id, row);
  }
  return result;
}

/** Carrega todos os vetores int8 para a busca densa brute-force. */
export function readAllEmbeddings(db: Database): EmbeddingRow[] {
  const rows = db.prepare("SELECT symbol_id, vector FROM embeddings").all() as Array<{
    symbol_id: number;
    vector: Buffer;
  }>;
  return rows.map((row) => ({ symbol_id: row.symbol_id, bytes: blobToInt8(row.vector) }));
}

/** Substitui o conjunto de embeddings inteiro + grava meta, atomicamente. */
export function replaceEmbeddings(
  db: Database,
  meta: EmbeddingsMeta,
  rows: EmbeddingInsert[],
): void {
  const tx = db.transaction(() => {
    db.exec("DELETE FROM embeddings");
    const insert = db.prepare(
      "INSERT INTO embeddings (symbol_id, vector, scale, dim, content_hash) VALUES (?, ?, ?, ?, ?)",
    );
    for (const row of rows) {
      insert.run(row.symbol_id, int8ToBlob(row.bytes), row.scale, meta.dim, row.content_hash);
    }
    db.prepare(
      `INSERT INTO embeddings_meta (id, model, dim, built_at, symbol_count, manifest_hash)
       VALUES (1, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         model = excluded.model, dim = excluded.dim, built_at = excluded.built_at,
         symbol_count = excluded.symbol_count, manifest_hash = excluded.manifest_hash`,
    ).run(meta.model, meta.dim, meta.built_at, meta.symbol_count, meta.manifest_hash);
  });
  tx();
}
