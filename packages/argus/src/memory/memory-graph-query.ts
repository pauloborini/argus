import type { MemoryV2Confidence } from "./v2-contract.js";
import type { MemoryGraphMechanism, MemoryGraphRef } from "./memory-graph-types.js";
import type { Database } from "./storage/sqlite-db.js";

interface RelationRow {
  note_id: string;
  note_path: string;
  note_title: string;
  mechanism: MemoryGraphMechanism;
  confidence: MemoryV2Confidence;
  evidence: string;
  source_note_id: string;
  entity_kind: string;
  canonical_key: string;
}

const BASE_SQL = `
  SELECT
    n.id AS note_id,
    n.path AS note_path,
    n.title AS note_title,
    r.mechanism,
    r.confidence,
    r.evidence,
    r.source_note_id,
    e.kind AS entity_kind,
    e.canonical_key
  FROM memory_relations r
  JOIN notes n ON n.id = r.source_note_id
  JOIN memory_entities e ON e.id = r.target_entity_id
`;

function mechanismReason(mechanism: MemoryGraphMechanism): string {
  switch (mechanism) {
    case "wikilink":
      return "wikilink";
    case "frontmatter_link":
      return "frontmatter_link";
    case "tag":
      return "tag_match";
    case "path_citation":
      return "path_citation";
    case "symbol_mention":
      return "symbol_mention";
    case "path_overlap":
      return "path_overlap";
    default:
      return "graph_relation";
  }
}

function confidenceScore(confidence: MemoryV2Confidence): number {
  switch (confidence) {
    case "confirmed":
      return 1;
    case "inferred":
      return 0.7;
    case "presumed":
      return 0.4;
    default:
      return 0.3;
  }
}

function toRef(row: RelationRow): MemoryGraphRef {
  return {
    path: row.note_path,
    title: row.note_title,
    score: confidenceScore(row.confidence),
    mechanism: row.mechanism,
    confidence: row.confidence,
    evidence: row.evidence,
    source_note_id: row.source_note_id,
    reason: mechanismReason(row.mechanism),
  };
}

function filterConsumerRefs(rows: RelationRow[]): MemoryGraphRef[] {
  return rows
    .filter((row) => {
      if (row.entity_kind === "path" && row.confidence !== "confirmed") {
        return false;
      }
      return row.confidence === "confirmed" || row.confidence === "inferred" || row.confidence === "presumed";
    })
    .map(toRef);
}

function uniqueRefs(refs: MemoryGraphRef[]): MemoryGraphRef[] {
  const seen = new Set<string>();
  const out: MemoryGraphRef[] = [];
  for (const ref of refs) {
    const key = `${ref.path}\0${ref.mechanism}\0${ref.evidence}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(ref);
  }
  return out.sort((left, right) => right.score - left.score);
}

export function queryMemoryGraphByPath(db: Database, filePath: string, limit = 5): MemoryGraphRef[] {
  const normalized = filePath.replace(/\\/g, "/").replace(/^\.\/+/, "");
  const base = normalized.split("/").pop() ?? normalized;
  const rows = db
    .prepare(
      `${BASE_SQL}
       WHERE (e.kind = 'path' AND (e.canonical_key = ? OR e.canonical_key LIKE ? OR e.canonical_key LIKE ?))
          OR (e.kind = 'symbol' AND e.canonical_key LIKE ?)
       ORDER BY r.confidence DESC, n.path
       LIMIT ?`,
    )
    .all(normalized, `%/${base}`, `%${normalized}%`, `%${normalized}::%`, limit * 3) as RelationRow[];
  return uniqueRefs(filterConsumerRefs(rows)).slice(0, limit);
}

export function queryMemoryGraphBySymbol(
  db: Database,
  symbolName: string,
  scopePath?: string,
  limit = 5,
): MemoryGraphRef[] {
  const rows = db
    .prepare(
      `${BASE_SQL}
       WHERE e.kind = 'symbol'
         AND (e.canonical_key LIKE ? OR e.label = ? OR e.canonical_key LIKE ?)
       ORDER BY r.confidence DESC, n.path
       LIMIT ?`,
    )
    .all(`%::${symbolName}`, symbolName, scopePath ? `%${scopePath}%::${symbolName}%` : `%::${symbolName}%`, limit * 3) as RelationRow[];
  return uniqueRefs(filterConsumerRefs(rows)).slice(0, limit);
}

export function queryMemoryGraphByTag(db: Database, tag: string, limit = 5): MemoryGraphRef[] {
  const normalized = tag.trim().toLowerCase();
  const rows = db
    .prepare(
      `${BASE_SQL}
       WHERE e.kind = 'tag' AND e.canonical_key = ?
       ORDER BY r.confidence DESC, n.path
       LIMIT ?`,
    )
    .all(normalized, limit * 2) as RelationRow[];
  return uniqueRefs(filterConsumerRefs(rows)).slice(0, limit);
}

export function queryMemoryGraphByNoteId(db: Database, noteId: string, limit = 10): MemoryGraphRef[] {
  const rows = db
    .prepare(
      `${BASE_SQL}
       WHERE r.source_note_id = ? OR (e.kind = 'note' AND e.canonical_key = ?)
       ORDER BY r.confidence DESC
       LIMIT ?`,
    )
    .all(noteId, noteId, limit) as RelationRow[];
  return uniqueRefs(rows.map(toRef)).slice(0, limit);
}

export function queryMemoryGraphForExplore(
  db: Database,
  mode: "file" | "symbol" | "topic",
  target: string,
  entryPath?: string,
  limit = 5,
): MemoryGraphRef[] {
  if (mode === "file" && entryPath) {
    return queryMemoryGraphByPath(db, entryPath, limit);
  }
  if (mode === "symbol") {
    return queryMemoryGraphBySymbol(db, target, entryPath, limit);
  }
  const byTag = queryMemoryGraphByTag(db, target, limit);
  if (byTag.length > 0) {
    return byTag;
  }
  const rows = db
    .prepare(
      `${BASE_SQL}
       WHERE n.path LIKE ? OR n.title LIKE ? OR r.evidence LIKE ?
       ORDER BY r.confidence DESC
       LIMIT ?`,
    )
    .all(`%${target}%`, `%${target}%`, `%${target}%`, limit * 2) as RelationRow[];
  return uniqueRefs(filterConsumerRefs(rows)).slice(0, limit);
}
