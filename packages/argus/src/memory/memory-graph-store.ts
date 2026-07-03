import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import type { CodeIndexReader } from "./code-index-reader.js";
import { extractGraphRelations, entityDraftId } from "./memory-graph-extractor.js";
import type { MemoryGraphEntityDraft, VaultNoteIndexEntry } from "./memory-graph-types.js";
import type { ParsedMarkdown } from "./markdown-parser.js";
import type { Database } from "./storage/sqlite-db.js";

function relationId(sourceNoteId: string, targetEntityId: string, mechanism: string, evidence: string): string {
  return createHash("sha256")
    .update(`${sourceNoteId}\0${targetEntityId}\0${mechanism}\0${evidence}`)
    .digest("hex")
    .slice(0, 16);
}

function upsertEntity(db: Database, entity: MemoryGraphEntityDraft): string {
  const id = entityDraftId(entity);
  db.prepare(
    `INSERT INTO memory_entities (id, kind, canonical_key, label)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(kind, canonical_key) DO UPDATE SET label = excluded.label`,
  ).run(id, entity.kind, entity.canonical_key, entity.label);
  return id;
}

export function clearMemoryGraph(db: Database): void {
  db.exec("DELETE FROM memory_relations; DELETE FROM memory_entities;");
}

export function rebuildMemoryGraph(
  db: Database,
  cwd: string,
  notes: Array<{ id: string; path: string; title: string; parsed: ParsedMarkdown }>,
  codeIndex: CodeIndexReader,
): string[] {
  const warnings: string[] = [];
  const codeIndexStatus = codeIndex.getStatus();
  let symbolMentions = 0;

  clearMemoryGraph(db);
  const vaultNotes: VaultNoteIndexEntry[] = notes.map((note) => ({
    id: note.id,
    path: note.path,
    title: note.title,
  }));

  const insertRelation = db.prepare(
    `INSERT INTO memory_relations (id, source_note_id, target_entity_id, mechanism, confidence, evidence)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );

  for (const note of notes) {
    upsertEntity(db, { kind: "note", canonical_key: note.id, label: note.title });
    const ctx = {
      cwd,
      noteId: note.id,
      notePath: note.path,
      noteTitle: note.title,
      vaultNotes,
      pathExists: (path: string) => existsSync(resolve(cwd, path)),
      resolveSymbol: (name: string, scope?: string) => codeIndex.resolveSymbol(name, scope),
    };
    const relations = extractGraphRelations(note.parsed, ctx);
    for (const relation of relations) {
      if (relation.mechanism === "symbol_mention") {
        symbolMentions += 1;
      }
      const targetEntityId = upsertEntity(db, relation.target);
      insertRelation.run(
        relationId(note.id, targetEntityId, relation.mechanism, relation.evidence),
        note.id,
        targetEntityId,
        relation.mechanism,
        relation.confidence,
        relation.evidence,
      );
    }
  }

  if (symbolMentions > 0 && codeIndexStatus !== "connected") {
    warnings.push(
      codeIndexStatus === "unavailable"
        ? "Índice de código ausente; relações de símbolo degradam para menção textual."
        : "Índice de código incompatível; relações de símbolo degradam para menção textual.",
    );
  }

  return warnings;
}
