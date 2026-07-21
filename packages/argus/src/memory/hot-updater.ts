/**
 * Projeção incremental quente de uma nota já persistida em Markdown.
 * Owner do upsert note/FTS (e embedding local opcional) — nunca chama VaultEngine.sync.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, relative, resolve } from "node:path";
import { int8ToBlob, quantizeInt8 } from "../embeddings/quantize.js";
import type { Embedder } from "../embeddings/embedder.js";
import { parseMarkdown } from "./markdown-parser.js";
import { getMemoryDbPath, getVaultDir } from "./paths.js";
import { closeMemoryDb, openMemoryDb, type Database } from "./storage/sqlite-db.js";
import { MEMORY_SQLITE_SCHEMA_VERSION } from "./storage/sqlite-schema.js";
import { memoryV2NoteInsertSql } from "./storage/sqlite-v2-migrate.js";
import { isLegacyV1Note, normalizeV2Metadata } from "./v2-metadata.js";

const VALID_TYPES = new Set(["inbox", "decision", "meeting", "entity", "project", "reference"]);

/** Budget de caracteres para embed síncrono no hot path; acima disso embedding fica pending. */
export const HOT_EMBED_MAX_CHARS = 8_000;

export type HotEmbeddingStatus = "updated" | "pending" | "unchanged" | "skipped" | "failed";

export interface HotUpdateInput {
  /** Caminho absoluto do Markdown no vault. */
  absolutePath: string;
  /** Conteúdo já gravado (evita re-leitura). */
  rawContent?: string;
  /** Relativo ao vault; se omitido, derivado de absolutePath. */
  vaultRelativePath?: string;
}

export interface HotUpdateResult {
  ok: boolean;
  note_id: string;
  path: string;
  fts_indexed: boolean;
  embedding_status: HotEmbeddingStatus;
  warnings: string[];
  error?: string;
  /** Código acionável quando a projeção falha após o Markdown já existir. */
  code?: "E_MEMORY_HOT_INDEX_FAILED" | "E_MEMORY_HOT_NOTE_MISSING";
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function computeVaultHash(vaultDir: string, files: string[]): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort()) {
    const rel = relative(vaultDir, file);
    hash.update(rel);
    hash.update("\0");
    hash.update(readFileSync(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function walkMarkdown(dir: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...walkMarkdown(full));
    } else if (entry.toLowerCase().endsWith(".md")) {
      out.push(full);
    }
  }
  return out;
}

interface PreparedNote {
  id: string;
  rel: string;
  title: string;
  type: string;
  tagsJson: string;
  linksJson: string;
  createdAt: string | null;
  updatedAt: string | null;
  body: string;
  contentHash: string;
  v2: ReturnType<typeof normalizeV2Metadata>;
}

function prepareNote(cwd: string, input: HotUpdateInput): PreparedNote {
  const vaultDir = getVaultDir(cwd);
  const absolutePath = resolve(input.absolutePath);
  const raw = input.rawContent ?? readFileSync(absolutePath, "utf-8");
  const rel = input.vaultRelativePath ?? relative(vaultDir, absolutePath);
  const parsed = parseMarkdown(raw, basename(absolutePath, extname(absolutePath)));
  const body = parsed.body.trim();
  const id = hashText(`${rel}\n${raw}`).slice(0, 16);
  const observedAt = parsed.observed_at ?? parsed.updated_at ?? parsed.created_at ?? new Date().toISOString();
  const v2 = normalizeV2Metadata(parsed, {
    notePath: rel,
    observedAt,
    isLegacyV1Note: isLegacyV1Note(parsed),
  });
  return {
    id,
    rel,
    title: parsed.title,
    type: VALID_TYPES.has(parsed.type) ? parsed.type : "inbox",
    tagsJson: JSON.stringify(parsed.tags),
    linksJson: JSON.stringify(parsed.links),
    createdAt: parsed.created_at ?? null,
    updatedAt: parsed.updated_at ?? null,
    body,
    contentHash: hashText(body),
    v2,
  };
}

function upsertNoteAndFts(db: Database, note: PreparedNote): void {
  const existing = db.prepare("SELECT id, content_hash FROM notes WHERE path = ?").get(note.rel) as
    | { id: string; content_hash: string }
    | undefined;

  if (existing) {
    db.prepare("DELETE FROM notes_fts WHERE note_id = ?").run(existing.id);
    if (existing.id !== note.id) {
      db.prepare("DELETE FROM note_embeddings WHERE note_id = ?").run(existing.id);
      db.prepare("DELETE FROM notes WHERE id = ?").run(existing.id);
    } else if (existing.content_hash !== note.contentHash) {
      db.prepare("DELETE FROM note_embeddings WHERE note_id = ?").run(note.id);
    }
  }

  if (existing && existing.id === note.id) {
    db.prepare(
      `UPDATE notes SET
         title = ?, type = ?, tags_json = ?, links_json = ?,
         created_at = ?, updated_at = ?, content = ?, content_hash = ?,
         scope = ?, source = ?, confidence = ?, observed_at = ?,
         valid_from = ?, valid_until = ?, superseded_by = ?, supersedes = ?,
         stale_reason = ?, contradiction_reason = ?, migrated_from_v1 = ?
       WHERE id = ?`,
    ).run(
      note.title,
      note.type,
      note.tagsJson,
      note.linksJson,
      note.createdAt,
      note.updatedAt,
      note.body,
      note.contentHash,
      note.v2.scope,
      note.v2.source,
      note.v2.confidence,
      note.v2.observed_at,
      note.v2.valid_from,
      note.v2.valid_until,
      note.v2.superseded_by,
      note.v2.supersedes,
      note.v2.stale_reason,
      note.v2.contradiction_reason,
      note.v2.migrated_from_v1,
      note.id,
    );
  } else {
    db.prepare(memoryV2NoteInsertSql()).run(
      note.id,
      note.rel,
      note.title,
      note.type,
      note.tagsJson,
      note.linksJson,
      note.createdAt,
      note.updatedAt,
      note.body,
      note.contentHash,
      note.v2.scope,
      note.v2.source,
      note.v2.confidence,
      note.v2.observed_at,
      note.v2.valid_from,
      note.v2.valid_until,
      note.v2.superseded_by,
      note.v2.supersedes,
      note.v2.stale_reason,
      note.v2.contradiction_reason,
      note.v2.migrated_from_v1,
    );
  }

  db.prepare("INSERT INTO notes_fts (note_id, path, title, content) VALUES (?, ?, ?, ?)").run(
    note.id,
    note.rel,
    note.title,
    note.body,
  );
}

function refreshMeta(db: Database, cwd: string): void {
  const vaultDir = getVaultDir(cwd);
  const files = walkMarkdown(vaultDir);
  const notesCount = (db.prepare("SELECT COUNT(*) AS c FROM notes").get() as { c: number }).c;
  db.prepare(
    `INSERT INTO memory_meta (id, schema_version, last_sync_at, notes_count, vault_hash)
     VALUES (1, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET schema_version = excluded.schema_version,
       last_sync_at = excluded.last_sync_at,
       notes_count = excluded.notes_count, vault_hash = excluded.vault_hash`,
  ).run(MEMORY_SQLITE_SCHEMA_VERSION, new Date().toISOString(), notesCount, computeVaultHash(vaultDir, files));
}

/**
 * Upsert transacional de uma nota + FTS. Não apaga outras notas/embeddings.
 * Retry no mesmo path é idempotente (substitui linha FTS da nota).
 */
export function hotUpdateNoteProjection(cwd: string, input: HotUpdateInput): HotUpdateResult {
  const absolutePath = resolve(input.absolutePath);
  if (!existsSync(absolutePath) && input.rawContent === undefined) {
    return {
      ok: false,
      note_id: "",
      path: input.vaultRelativePath ?? "",
      fts_indexed: false,
      embedding_status: "skipped",
      warnings: [],
      code: "E_MEMORY_HOT_NOTE_MISSING",
      error: "E_MEMORY_HOT_NOTE_MISSING: arquivo da nota ausente para indexação quente.",
    };
  }

  let note: PreparedNote;
  try {
    note = prepareNote(cwd, { ...input, absolutePath });
  } catch (err) {
    return {
      ok: false,
      note_id: "",
      path: input.vaultRelativePath ?? relative(getVaultDir(cwd), absolutePath),
      fts_indexed: false,
      embedding_status: "skipped",
      warnings: [],
      code: "E_MEMORY_HOT_INDEX_FAILED",
      error: `E_MEMORY_HOT_INDEX_FAILED: ${err instanceof Error ? err.message : String(err)}. Retry idempotente: repita remember/hot-update.`,
    };
  }

  const warnings = [...note.v2.warnings];

  // Garante schema/migração sem wipe.
  if (!existsSync(getMemoryDbPath(cwd))) {
    const bootstrap = openMemoryDb(cwd);
    closeMemoryDb(bootstrap);
  }

  const db = openMemoryDb(cwd);
  try {
    const tx = db.transaction(() => {
      upsertNoteAndFts(db, note);
      refreshMeta(db, cwd);
    });
    tx();

    // FTS imediato. Embed unitário fica a cargo de `hotUpdateNoteEmbedding` (chamado pelo remember).
    // Aqui só sinaliza pending/unchanged — nunca wipe global nem sync.
    const existingEmb = db
      .prepare("SELECT content_hash FROM note_embeddings WHERE note_id = ?")
      .get(note.id) as { content_hash: string } | undefined;
    const embeddingStatus: HotEmbeddingStatus =
      existingEmb?.content_hash === note.contentHash ? "unchanged" : "pending";
    if (embeddingStatus === "pending" && note.body.length > HOT_EMBED_MAX_CHARS) {
      warnings.push(
        `Embedding acima do budget hot (${HOT_EMBED_MAX_CHARS} chars); use argus memory embed (não sync).`,
      );
    }

    return {
      ok: true,
      note_id: note.id,
      path: note.rel,
      fts_indexed: true,
      embedding_status: embeddingStatus,
      warnings,
    };
  } catch (err) {
    return {
      ok: false,
      note_id: note.id,
      path: note.rel,
      fts_indexed: false,
      embedding_status: "skipped",
      warnings,
      code: "E_MEMORY_HOT_INDEX_FAILED",
      error: `E_MEMORY_HOT_INDEX_FAILED: ${err instanceof Error ? err.message : String(err)}. Retry idempotente: repita remember/hot-update.`,
    };
  } finally {
    closeMemoryDb(db);
  }
}

/**
 * Atualiza embedding de uma única nota sem rebuild global.
 * Preserva embeddings de outras notas.
 */
export async function hotUpdateNoteEmbedding(
  cwd: string,
  noteId: string,
  embedder: Embedder,
): Promise<HotEmbeddingStatus> {
  const db = openMemoryDb(cwd);
  try {
    const row = db.prepare("SELECT id, title, content, content_hash FROM notes WHERE id = ?").get(noteId) as
      | { id: string; title: string; content: string; content_hash: string }
      | undefined;
    if (!row) {
      return "skipped";
    }
    if (row.content.length > HOT_EMBED_MAX_CHARS) {
      return "pending";
    }
    const existing = db.prepare("SELECT content_hash FROM note_embeddings WHERE note_id = ?").get(noteId) as
      | { content_hash: string }
      | undefined;
    if (existing?.content_hash === row.content_hash) {
      return "unchanged";
    }
    const [vector] = await embedder.embed([`${row.title}\n${row.content}`]);
    if (!vector) {
      return "failed";
    }
    const q = quantizeInt8(vector);
    db.prepare(
      `INSERT INTO note_embeddings (note_id, vector, scale, dim, content_hash)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(note_id) DO UPDATE SET
         vector = excluded.vector, scale = excluded.scale, dim = excluded.dim, content_hash = excluded.content_hash`,
    ).run(noteId, int8ToBlob(q.bytes), q.scale, vector.length, row.content_hash);
    return "updated";
  } finally {
    closeMemoryDb(db);
  }
}

/** Conta embeddings (para provas de não-wipe). */
export function countNoteEmbeddings(cwd: string): number {
  if (!existsSync(getMemoryDbPath(cwd))) {
    return 0;
  }
  const db = openMemoryDb(cwd, { readonly: true });
  try {
    return (db.prepare("SELECT COUNT(*) AS c FROM note_embeddings").get() as { c: number }).c;
  } finally {
    closeMemoryDb(db);
  }
}

/** IDs com embedding (prova de preservação). */
export function readEmbeddingNoteIds(cwd: string): string[] {
  if (!existsSync(getMemoryDbPath(cwd))) {
    return [];
  }
  const db = openMemoryDb(cwd, { readonly: true });
  try {
    const rows = db.prepare("SELECT note_id FROM note_embeddings ORDER BY note_id").all() as Array<{
      note_id: string;
    }>;
    return rows.map((row) => row.note_id);
  } finally {
    closeMemoryDb(db);
  }
}

/** Hook legado — sem sync full; no-op seguro. */
export function triggerMemoryRefresh(): void {
  // Daemon/background futuro; request path usa hotUpdateNoteProjection.
}
