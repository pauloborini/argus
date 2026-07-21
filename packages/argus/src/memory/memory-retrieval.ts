import {
  MEMORY_V2_ACTIVE_SCOPES,
  type MemoryV2ActiveScope,
  type MemoryV2Source,
} from "./v2-contract.js";

export type MemoryMatchMechanism = "hybrid-rrf" | "fts-only" | "dense-only" | "lexical";

export interface MemoryReadFilter {
  scopes?: MemoryV2ActiveScope[];
  asOf?: string;
  sources?: MemoryV2Source[];
}

export interface MemoryNoteV2Row {
  note_id: string;
  path: string;
  title: string;
  type: string;
  content: string;
  scope: string;
  source: string;
  confidence: string;
  observed_at: string | null;
  valid_from: string | null;
  valid_until: string | null;
  superseded_by: string | null;
  supersedes: string | null;
  stale_reason: string | null;
  contradiction_reason: string | null;
}

export interface MemoryRankFactors {
  base: number;
  confidence: number;
  recency: number;
  stale: number;
  contradiction: number;
}

export interface MemoryRetrievalChunk {
  note_id: string;
  path: string;
  title: string;
  type: string;
  score: number;
  snippet: string;
  content?: string;
  mechanism: MemoryMatchMechanism;
  scope?: string;
  source?: string;
  confidence?: string;
  observed_at?: string;
  stale_reason?: string;
  contradiction_reason?: string;
  superseded_by?: string;
  /** Componentes do score após fatores v2 (auditoria). */
  rank_factors?: MemoryRankFactors;
  /** Motivo curto suficiente para auditoria (sinais + confidence). */
  rank_reason?: string;
}

/**
 * Pesos default P5 do guide — centralizados, monotônicos e documentados.
 * confirmed > inferred > presumed; stale/contradiction penalizam; recência suave com piso.
 */
export const MEMORY_V2_RANKING_WEIGHTS = {
  confidence: {
    confirmed: 1.2,
    inferred: 1.05,
    presumed: 1.0,
  },
  stale: 0.5,
  contradiction: 0.35,
  /** Meia-vida da recência em dias; piso evita apagar decisões antigas confirmadas. */
  recency: {
    halfLifeDays: 90,
    floor: 0.7,
  },
} as const;

export const DEFAULT_READ_SCOPES: MemoryV2ActiveScope[] = [...MEMORY_V2_ACTIVE_SCOPES];

export function defaultMemoryReadFilter(): MemoryReadFilter {
  return { scopes: DEFAULT_READ_SCOPES };
}

export function isScopeReadable(scope: string, filter: MemoryReadFilter): boolean {
  if (scope === "org") {
    return false;
  }
  const allowed = filter.scopes ?? DEFAULT_READ_SCOPES;
  return (allowed as readonly string[]).includes(scope);
}

export function isTemporalReadable(row: MemoryNoteV2Row, asOf: Date): boolean {
  if (row.valid_from) {
    const from = new Date(row.valid_from);
    if (!Number.isNaN(from.getTime()) && from > asOf) {
      return false;
    }
  }
  return true;
}

export function isSupersededForDefaultRead(row: MemoryNoteV2Row): boolean {
  return Boolean(row.superseded_by?.trim());
}

export function enrichTemporalSignals(row: MemoryNoteV2Row, asOf: Date): MemoryNoteV2Row {
  if (row.stale_reason?.trim()) {
    return row;
  }
  if (row.valid_until) {
    const until = new Date(row.valid_until);
    if (!Number.isNaN(until.getTime()) && until < asOf) {
      return { ...row, stale_reason: "valid_until_expired" };
    }
  }
  return row;
}

export function passesV2ReadFilter(
  row: MemoryNoteV2Row,
  filter: MemoryReadFilter = defaultMemoryReadFilter(),
): boolean {
  const asOf = filter.asOf ? new Date(filter.asOf) : new Date();
  if (!isScopeReadable(row.scope, filter)) {
    return false;
  }
  if (!isTemporalReadable(row, asOf)) {
    return false;
  }
  if (isSupersededForDefaultRead(row)) {
    return false;
  }
  if (filter.sources?.length && !(filter.sources as readonly string[]).includes(row.source)) {
    return false;
  }
  return true;
}

export function deriveReadState(chunks: MemoryRetrievalChunk[]): "sucesso" | "parcial" {
  if (chunks.some((chunk) => chunk.stale_reason || chunk.contradiction_reason)) {
    return "parcial";
  }
  return "sucesso";
}

function confidenceMultiplier(confidence: string | undefined): number {
  const key = (confidence ?? "presumed") as keyof typeof MEMORY_V2_RANKING_WEIGHTS.confidence;
  return MEMORY_V2_RANKING_WEIGHTS.confidence[key] ?? MEMORY_V2_RANKING_WEIGHTS.confidence.presumed;
}

function recencyMultiplier(observedAt: string | null | undefined, asOf: Date): number {
  if (!observedAt) {
    return MEMORY_V2_RANKING_WEIGHTS.recency.floor;
  }
  const observed = new Date(observedAt);
  if (Number.isNaN(observed.getTime())) {
    return MEMORY_V2_RANKING_WEIGHTS.recency.floor;
  }
  const ageMs = Math.max(0, asOf.getTime() - observed.getTime());
  const halfLifeMs = MEMORY_V2_RANKING_WEIGHTS.recency.halfLifeDays * 24 * 60 * 60 * 1000;
  const decay = Math.pow(0.5, ageMs / halfLifeMs);
  return Math.max(MEMORY_V2_RANKING_WEIGHTS.recency.floor, decay);
}

/**
 * Ajusta score-base (FTS/RRF já normalizado) pelos fatores v2.
 * Monotônico: confirmed ≥ inferred ≥ presumed; stale/contradiction ≤ saudável.
 */
export function applyV2RankingFactors(
  baseScore: number,
  row: Pick<
    MemoryNoteV2Row,
    "confidence" | "observed_at" | "stale_reason" | "contradiction_reason"
  >,
  asOf: Date = new Date(),
): { score: number; factors: MemoryRankFactors; rank_reason: string } {
  const confidence = confidenceMultiplier(row.confidence);
  const recency = recencyMultiplier(row.observed_at, asOf);
  const stale = row.stale_reason?.trim() ? MEMORY_V2_RANKING_WEIGHTS.stale : 1;
  const contradiction = row.contradiction_reason?.trim()
    ? MEMORY_V2_RANKING_WEIGHTS.contradiction
    : 1;
  const score = baseScore * confidence * recency * stale * contradiction;
  const parts: string[] = [row.confidence?.trim() || "presumed"];
  if (row.stale_reason?.trim()) {
    parts.push(`stale:${row.stale_reason.trim()}`);
  }
  if (row.contradiction_reason?.trim()) {
    parts.push(`contradiction:${row.contradiction_reason.trim()}`);
  }
  if (recency <= MEMORY_V2_RANKING_WEIGHTS.recency.floor + 1e-9) {
    parts.push("recency:floor");
  } else if (recency < 0.95) {
    parts.push("recency:decay");
  } else {
    parts.push("recency:fresh");
  }
  return {
    score,
    factors: { base: baseScore, confidence, recency, stale, contradiction },
    rank_reason: parts.join(";"),
  };
}

/** Reordena chunks pelo score v2 (após score-base). */
export function rerankChunksWithV2Factors(
  chunks: MemoryRetrievalChunk[],
  asOf: Date = new Date(),
): MemoryRetrievalChunk[] {
  return chunks
    .map((chunk) => {
      const ranked = applyV2RankingFactors(
        chunk.score,
        {
          confidence: chunk.confidence ?? "presumed",
          observed_at: chunk.observed_at ?? null,
          stale_reason: chunk.stale_reason ?? null,
          contradiction_reason: chunk.contradiction_reason ?? null,
        },
        asOf,
      );
      return {
        ...chunk,
        score: Number(ranked.score.toFixed(4)),
        rank_factors: ranked.factors,
        rank_reason: ranked.rank_reason,
      };
    })
    .sort((a, b) => b.score - a.score || a.note_id.localeCompare(b.note_id));
}

export function normalizeMemoryChunk(
  row: MemoryNoteV2Row,
  score: number,
  mechanism: MemoryMatchMechanism,
  snippet: string,
  includeContent?: boolean,
  asOf: Date = new Date(),
): MemoryRetrievalChunk {
  const enriched = enrichTemporalSignals(row, asOf);
  const ranked = applyV2RankingFactors(score, enriched, asOf);
  const chunk: MemoryRetrievalChunk = {
    note_id: enriched.note_id,
    path: enriched.path,
    title: enriched.title,
    type: enriched.type,
    score: Number(ranked.score.toFixed(4)),
    snippet,
    mechanism,
    scope: enriched.scope,
    source: enriched.source,
    confidence: enriched.confidence,
    rank_factors: ranked.factors,
    rank_reason: ranked.rank_reason,
  };
  if (enriched.observed_at) {
    chunk.observed_at = enriched.observed_at;
  }
  if (enriched.stale_reason) {
    chunk.stale_reason = enriched.stale_reason;
  }
  if (enriched.contradiction_reason) {
    chunk.contradiction_reason = enriched.contradiction_reason;
  }
  if (enriched.superseded_by) {
    chunk.superseded_by = enriched.superseded_by;
  }
  if (includeContent) {
    chunk.content = enriched.content;
  }
  return chunk;
}

/** SQL WHERE fragment for v2 read filters applied before ranking. */
export function buildV2ReadSqlFilter(filter: MemoryReadFilter = defaultMemoryReadFilter()): {
  clause: string;
  params: string[];
} {
  const scopes = filter.scopes ?? DEFAULT_READ_SCOPES;
  const scopePlaceholders = scopes.map(() => "?").join(", ");
  const asOf = filter.asOf ?? new Date().toISOString();
  const clauses = [
    `n.scope IN (${scopePlaceholders})`,
    "(n.superseded_by IS NULL OR TRIM(n.superseded_by) = '')",
    "(n.valid_from IS NULL OR n.valid_from <= ?)",
  ];
  const params: string[] = [...scopes, asOf];

  if (filter.sources?.length) {
    const sourcePlaceholders = filter.sources.map(() => "?").join(", ");
    clauses.push(`n.source IN (${sourcePlaceholders})`);
    params.push(...filter.sources);
  }

  return {
    clause: clauses.join("\n      AND "),
    params,
  };
}

export const MEMORY_NOTE_V2_SELECT = `
  n.id AS note_id, n.path, n.title, n.type, n.content,
  n.scope, n.source, n.confidence, n.observed_at,
  n.valid_from, n.valid_until, n.superseded_by, n.supersedes,
  n.stale_reason, n.contradiction_reason
`;
