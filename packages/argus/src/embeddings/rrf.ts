// Reciprocal Rank Fusion: funde múltiplas listas rankeadas (lexical BM25 +
// denso cosine) sem precisar normalizar escalas heterogêneas de score. Cada
// item contribui 1/(k + rank) por lista em que aparece; k amortece o peso do
// topo (padrão 60, valor canônico da literatura de IR).

export interface FusedItem<T> {
  id: T;
  score: number;
}

/**
 * Funde listas ordenadas (melhor → pior) de ids por RRF. Ids podem aparecer em
 * mais de uma lista; o score soma as contribuições. Retorna ordenado por score
 * desc, com desempate determinístico pelo id.
 */
export function reciprocalRankFusion<T extends string | number>(
  lists: ReadonlyArray<ReadonlyArray<T>>,
  k = 60,
): FusedItem<T>[] {
  const scores = new Map<T, number>();
  for (const list of lists) {
    for (let rank = 0; rank < list.length; rank += 1) {
      const id = list[rank];
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank + 1));
    }
  }
  return Array.from(scores.entries())
    .map(([id, score]) => ({ id, score }))
    .sort((left, right) => right.score - left.score || String(left.id).localeCompare(String(right.id)));
}
