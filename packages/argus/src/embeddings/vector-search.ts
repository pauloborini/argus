// Busca densa brute-force: varre todos os vetores int8 e rankeia por cosine.
// Para repos típicos (dezenas de milhares de símbolos × 384 dims int8) isso é
// uma varredura de poucos MB em memória — milissegundos, sem dep nativa de
// vector-store. sqlite-vec só compensaria em escala que não temos.

import { cosineInt8 } from "./quantize.js";

export interface EmbeddingRow {
  symbol_id: number;
  bytes: Int8Array;
}

export interface DenseHit {
  symbol_id: number;
  score: number;
}

/**
 * Top-K por cosine entre `queryBytes` (query já quantizada) e cada linha.
 * `allow` opcional restringe a busca a um conjunto de symbol_ids (filtro de
 * scope/kind resolvido a montante). Empate desambiguado por symbol_id.
 */
export function denseTopK(
  rows: ReadonlyArray<EmbeddingRow>,
  queryBytes: Int8Array,
  k: number,
  allow?: ReadonlySet<number>,
): DenseHit[] {
  const hits: DenseHit[] = [];
  for (const row of rows) {
    if (allow && !allow.has(row.symbol_id)) {
      continue;
    }
    hits.push({ symbol_id: row.symbol_id, score: cosineInt8(queryBytes, row.bytes) });
  }
  hits.sort((left, right) => right.score - left.score || left.symbol_id - right.symbol_id);
  return hits.slice(0, k);
}
