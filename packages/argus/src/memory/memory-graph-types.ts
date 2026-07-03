import type { MemoryV2Confidence } from "./v2-contract.js";

export const MEMORY_GRAPH_ENTITY_KINDS = ["note", "tag", "path", "symbol"] as const;
export type MemoryGraphEntityKind = (typeof MEMORY_GRAPH_ENTITY_KINDS)[number];

export const MEMORY_GRAPH_MECHANISMS = [
  "wikilink",
  "frontmatter_link",
  "tag",
  "path_citation",
  "symbol_mention",
  "path_overlap",
] as const;
export type MemoryGraphMechanism = (typeof MEMORY_GRAPH_MECHANISMS)[number];

export interface MemoryGraphEntityDraft {
  kind: MemoryGraphEntityKind;
  canonical_key: string;
  label: string;
}

export interface MemoryGraphRelationDraft {
  target: MemoryGraphEntityDraft;
  mechanism: MemoryGraphMechanism;
  confidence: MemoryV2Confidence;
  evidence: string;
}

export interface MemoryGraphRef {
  path: string;
  title: string;
  score: number;
  mechanism: MemoryGraphMechanism;
  confidence: MemoryV2Confidence;
  evidence: string;
  source_note_id: string;
  reason: string;
}

export interface VaultNoteIndexEntry {
  id: string;
  path: string;
  title: string;
}

export interface GraphExtractionContext {
  cwd: string;
  noteId: string;
  notePath: string;
  noteTitle: string;
  vaultNotes: VaultNoteIndexEntry[];
  pathExists: (path: string) => boolean;
  resolveSymbol: (name: string, scope?: string) => Array<{ file: string; line: number; symbol: string }>;
}
