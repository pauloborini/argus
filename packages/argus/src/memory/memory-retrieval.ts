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
  stale_reason?: string;
  contradiction_reason?: string;
  superseded_by?: string;
}

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

export function normalizeMemoryChunk(
  row: MemoryNoteV2Row,
  score: number,
  mechanism: MemoryMatchMechanism,
  snippet: string,
  includeContent?: boolean,
): MemoryRetrievalChunk {
  const enriched = enrichTemporalSignals(row, new Date());
  const chunk: MemoryRetrievalChunk = {
    note_id: enriched.note_id,
    path: enriched.path,
    title: enriched.title,
    type: enriched.type,
    score: Number(score.toFixed(4)),
    snippet,
    mechanism,
    scope: enriched.scope,
    source: enriched.source,
    confidence: enriched.confidence,
  };
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
  const placeholders = scopes.map(() => "?").join(", ");
  return {
    clause: `n.scope IN (${placeholders})
      AND (n.superseded_by IS NULL OR TRIM(n.superseded_by) = '')
      AND (n.valid_from IS NULL OR n.valid_from <= datetime('now'))`,
    params: [...scopes],
  };
}

export const MEMORY_NOTE_V2_SELECT = `
  n.id AS note_id, n.path, n.title, n.type, n.content,
  n.scope, n.source, n.confidence, n.observed_at,
  n.valid_from, n.valid_until, n.superseded_by, n.supersedes,
  n.stale_reason, n.contradiction_reason
`;
