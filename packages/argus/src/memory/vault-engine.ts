import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, rmSync } from "node:fs";
import { basename, extname, join, relative, resolve } from "node:path";
import { stubResponse } from "../contracts/response-state.js";
import { blobToInt8, int8ToBlob, quantizeInt8 } from "../embeddings/quantize.js";
import { BGE_QUERY_INSTRUCTION, createEmbedder, EmbeddingsUnavailableError, type Embedder } from "../embeddings/embedder.js";
import { denseTopK, type EmbeddingRow } from "../embeddings/vector-search.js";
import { reciprocalRankFusion } from "../embeddings/rrf.js";
import type { ToolResponsePayload } from "../mcp/tools/common.js";
import { defaultMemoryConfig, loadMemoryConfig, writeMemoryConfig } from "./config.js";
import { parseMarkdown } from "./markdown-parser.js";
import { getMemoryDbPath, getVaultDir, VAULT_SUBDIRS, type VaultSubdir } from "./paths.js";
import { closeMemoryDb, openMemoryDb, type Database } from "./storage/sqlite-db.js";

const VALID_TYPES = new Set(["inbox", "decision", "meeting", "entity", "project", "reference"]);

export interface RememberOptions {
  type?: string;
  tags?: string[];
  links?: string[];
  file?: string;
}

export interface MemorySearchResult {
  note_id: string;
  path: string;
  title: string;
  type: string;
  score: number;
  snippet: string;
  content?: string;
}

export interface MemoryStatus {
  initialized: boolean;
  staleness: "fresh" | "stale" | "unknown";
  notes_count: number;
  last_sync_at: string | null;
  embeddings_ready: boolean;
  error?: string;
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function slugify(input: string): string {
  return input
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50) || "nota";
}

function yamlList(values: string[]): string {
  return `[${values.map((item) => JSON.stringify(item)).join(", ")}]`;
}

function timestampForFile(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
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
  return out.sort();
}

function computeVaultHash(vaultDir: string, files: string[]): string {
  const hash = createHash("sha256");
  for (const file of files) {
    const rel = relative(vaultDir, file);
    hash.update(rel);
    hash.update("\0");
    hash.update(readFileSync(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function escapeFts(query: string): string {
  const terms = query.match(/[\p{L}\p{N}_-]+/gu) ?? [];
  return terms.map((term) => `"${term.replace(/"/g, '""')}"`).join(" OR ") || `"${query.replace(/"/g, '""')}"`;
}

function ftsRows(db: Database, query: string, limit: number): MemorySearchResult[] {
  const rows = db
    .prepare(
      `SELECT n.id AS note_id, n.path, n.title, n.type, n.content,
              snippet(notes_fts, 3, '', '', ' … ', 20) AS snippet,
              bm25(notes_fts) AS rank
       FROM notes_fts
       JOIN notes n ON n.id = notes_fts.note_id
       WHERE notes_fts MATCH ?
       ORDER BY rank
       LIMIT ?`,
    )
    .all(escapeFts(query), limit) as Array<MemorySearchResult & { rank: number; content: string }>;
  return rows.map((row, index) => ({
    note_id: row.note_id,
    path: row.path,
    title: row.title,
    type: row.type,
    score: Number((1 / (index + 1)).toFixed(4)),
    snippet: row.snippet || row.content.slice(0, 240),
    content: row.content,
  }));
}

function readAllNoteEmbeddings(db: Database): EmbeddingRow[] {
  const rows = db.prepare("SELECT note_id, vector FROM note_embeddings").all() as Array<{
    note_id: string;
    vector: Buffer;
  }>;
  return rows.map((row) => ({ symbol_id: Number.parseInt(row.note_id.slice(0, 12), 16), bytes: blobToInt8(row.vector) }));
}

function readNotesByPseudoIds(db: Database, pseudoIds: number[]): Map<number, MemorySearchResult> {
  const notes = db
    .prepare("SELECT id AS note_id, path, title, type, content FROM notes")
    .all() as Array<MemorySearchResult & { content: string }>;
  const map = new Map<number, MemorySearchResult>();
  for (const note of notes) {
    const pseudo = Number.parseInt(note.note_id.slice(0, 12), 16);
    if (pseudoIds.includes(pseudo)) {
      map.set(pseudo, { ...note, score: 0, snippet: note.content.slice(0, 240), content: note.content });
    }
  }
  return map;
}

function buildMemoryResultsByPseudoIds(
  db: Database,
  ordered: number[],
  scoreById?: Map<number, number>,
): MemorySearchResult[] {
  const notes = readNotesByPseudoIds(db, ordered);
  return ordered
    .map((id, index) => {
      const note = notes.get(id);
      return note
        ? { ...note, score: Number((scoreById?.get(id) ?? 1 / (index + 1)).toFixed(4)) }
        : null;
    })
    .filter((item): item is MemorySearchResult => item !== null);
}

async function hybridRows(
  db: Database,
  query: string,
  limit: number,
  embedderOverride?: Embedder,
): Promise<{ chunks: MemorySearchResult[]; mechanism: "hybrid-rrf" | "fts-only" }> {
  const lexical = ftsRows(db, query, Math.max(limit, 50));
  const rows = readAllNoteEmbeddings(db);
  if (rows.length === 0) {
    return { chunks: lexical.slice(0, limit), mechanism: "fts-only" };
  }
  const embedder = embedderOverride ?? createEmbedder();
  const [queryVector] = await embedder.embed([`${BGE_QUERY_INSTRUCTION}${query}`]);
  const q = quantizeInt8(queryVector!);
  const dense = denseTopK(rows, q.bytes, Math.max(limit, 50));
  const lexicalIds = lexical.map((hit) => Number.parseInt(hit.note_id.slice(0, 12), 16));
  const fused = reciprocalRankFusion([dense.map((hit) => hit.symbol_id), lexicalIds]).slice(0, limit);
  return {
    mechanism: "hybrid-rrf",
    chunks: buildMemoryResultsByPseudoIds(
      db,
      fused.map((item) => item.id),
      new Map(fused.map((item) => [item.id, item.score])),
    ),
  };
}

export class VaultEngine {
  static init(cwd: string = process.cwd()): ToolResponsePayload {
    const vaultDir = getVaultDir(cwd);
    const created_dirs: string[] = [];
    mkdirSync(vaultDir, { recursive: true });
    for (const subdir of VAULT_SUBDIRS) {
      const full = join(vaultDir, subdir);
      if (!existsSync(full)) {
        mkdirSync(full, { recursive: true });
        created_dirs.push(`vault/${subdir}`);
      }
    }
    writeMemoryConfig({ ...defaultMemoryConfig(cwd), ...(loadMemoryConfig(cwd) ?? {}) }, cwd);
    const db = openMemoryDb(cwd);
    closeMemoryDb(db);
    return {
      vault_path: vaultDir,
      db_path: getMemoryDbPath(cwd),
      created_dirs,
      ...stubResponse("sucesso", created_dirs.length ? "Cofre de memória inicializado." : "Cofre de memória já inicializado."),
    };
  }

  static remember(content: string, options: RememberOptions = {}, cwd: string = process.cwd()): ToolResponsePayload {
    if (!content.trim() && !options.file) {
      return { note_path: "", note_id: "", ...stubResponse("falha", "E_MEMORY_INPUT_INVALID: conteúdo vazio.") };
    }
    VaultEngine.init(cwd);
    const raw = options.file ? readFileSync(resolve(options.file), "utf-8") : content;
    const parsed = parseMarkdown(raw, "nota");
    const type = VALID_TYPES.has(options.type ?? "") ? options.type! : parsed.type;
    const targetType = VALID_TYPES.has(type) ? type : "inbox";
    const now = new Date().toISOString();
    const title = parsed.title || raw.split(/\r?\n/)[0]?.trim() || "Sem título";
    const tags = options.tags?.length ? options.tags : parsed.tags;
    const links = options.links?.length ? options.links : parsed.links;
    const fileName = `${timestampForFile()}_${slugify(title)}.md`;
    const noteDir = join(getVaultDir(cwd), targetType as VaultSubdir);
    mkdirSync(noteDir, { recursive: true });
    const notePath = join(noteDir, fileName);
    const finalContent = [
      "---",
      `title: ${JSON.stringify(title)}`,
      `type: ${targetType}`,
      `tags: ${yamlList(tags)}`,
      `links: ${yamlList(links)}`,
      `created_at: ${now}`,
      `updated_at: ${now}`,
      "---",
      "",
      parsed.body.trim(),
      "",
    ].join("\n");
    writeFileSync(notePath, finalContent, "utf-8");
    const noteId = hashText(`${relative(getVaultDir(cwd), notePath)}\n${finalContent}`).slice(0, 16);
    return {
      note_path: relative(getVaultDir(cwd), notePath),
      note_id: noteId,
      ...stubResponse("sucesso", "Nota capturada no cofre de memória."),
    };
  }

  static sync(cwd: string = process.cwd()): ToolResponsePayload {
    VaultEngine.init(cwd);
    const vaultDir = getVaultDir(cwd);
    const files = walkMarkdown(vaultDir);
    const db = openMemoryDb(cwd);
    try {
      const tx = db.transaction(() => {
        db.exec("DELETE FROM notes_fts; DELETE FROM note_embeddings; DELETE FROM notes;");
        const insertNote = db.prepare(
          `INSERT INTO notes (id, path, title, type, tags_json, links_json, created_at, updated_at, content, content_hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        const insertFts = db.prepare("INSERT INTO notes_fts (note_id, path, title, content) VALUES (?, ?, ?, ?)");
        for (const file of files) {
          const raw = readFileSync(file, "utf-8");
          const rel = relative(vaultDir, file);
          const parsed = parseMarkdown(raw, basename(file, extname(file)));
          const body = parsed.body.trim();
          const id = hashText(`${rel}\n${raw}`).slice(0, 16);
          insertNote.run(
            id,
            rel,
            parsed.title,
            VALID_TYPES.has(parsed.type) ? parsed.type : "inbox",
            JSON.stringify(parsed.tags),
            JSON.stringify(parsed.links),
            parsed.created_at ?? null,
            parsed.updated_at ?? null,
            body,
            hashText(body),
          );
          insertFts.run(id, rel, parsed.title, body);
        }
        db.prepare(
          `INSERT INTO memory_meta (id, schema_version, last_sync_at, notes_count, vault_hash)
           VALUES (1, '1.0.0', ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET last_sync_at = excluded.last_sync_at,
             notes_count = excluded.notes_count, vault_hash = excluded.vault_hash`,
        ).run(new Date().toISOString(), files.length, computeVaultHash(vaultDir, files));
      });
      tx();
      return { notes_count: files.length, ...stubResponse("sucesso", "Cofre sincronizado.") };
    } finally {
      closeMemoryDb(db);
    }
  }

  static async embed(cwd: string = process.cwd(), embedderOverride?: Embedder): Promise<ToolResponsePayload> {
    VaultEngine.sync(cwd);
    const db = openMemoryDb(cwd);
    try {
      const notes = db.prepare("SELECT id, title, content, content_hash FROM notes ORDER BY path").all() as Array<{
        id: string;
        title: string;
        content: string;
        content_hash: string;
      }>;
      if (notes.length === 0) {
        return { note_count: 0, ...stubResponse("sucesso", "Nenhuma nota para embeddar.") };
      }
      const embedder = embedderOverride ?? createEmbedder();
      const vectors = await embedder.embed(notes.map((note) => `${note.title}\n${note.content}`));
      const tx = db.transaction(() => {
        db.exec("DELETE FROM note_embeddings");
        const insert = db.prepare(
          "INSERT INTO note_embeddings (note_id, vector, scale, dim, content_hash) VALUES (?, ?, ?, ?, ?)",
        );
        for (let i = 0; i < notes.length; i += 1) {
          const note = notes[i]!;
          const vector = vectors[i]!;
          const q = quantizeInt8(vector);
          insert.run(note.id, int8ToBlob(q.bytes), q.scale, vector.length, note.content_hash);
        }
        db.prepare(
          `INSERT INTO note_embeddings_meta (id, model, dim, built_at, note_count, vault_hash)
           VALUES (1, ?, ?, ?, ?, (SELECT vault_hash FROM memory_meta WHERE id = 1))
           ON CONFLICT(id) DO UPDATE SET model = excluded.model, dim = excluded.dim,
             built_at = excluded.built_at, note_count = excluded.note_count, vault_hash = excluded.vault_hash`,
        ).run("Xenova/bge-small-en-v1.5", vectors[0]!.length, new Date().toISOString(), notes.length);
      });
      tx();
      return { note_count: notes.length, ...stubResponse("sucesso", "Embeddings de memória gerados.") };
    } catch (err) {
      if (err instanceof EmbeddingsUnavailableError) {
        return { note_count: 0, ...stubResponse("parcial", err.message, { limitations: ["Busca FTS segue disponível."] }) };
      }
      throw err;
    } finally {
      closeMemoryDb(db);
    }
  }

  static search(
    query: string,
    options: { limit?: number; includeSnippets?: boolean; includeContent?: boolean } = {},
    cwd: string = process.cwd(),
  ): ToolResponsePayload & { chunks: MemorySearchResult[]; mechanism: string } {
    const limit = Math.max(1, Math.min(options.limit ?? 10, 50));
    if (!existsSync(getMemoryDbPath(cwd))) {
      return {
        mechanism: "fts-only",
        chunks: [],
        ...stubResponse("parcial", "W_MEMORY_UNAVAILABLE: cofre de memória ausente.", {
          limitations: ["Execute argus memory init/sync para habilitar recall."],
        }),
      };
    }
    const db = openMemoryDb(cwd, { readonly: true });
    try {
      const lexical = ftsRows(db, query, Math.max(limit, 50));
      let chunks = lexical.slice(0, limit);
      const mechanism = "fts-only";
      if (!options.includeContent) {
        chunks = chunks.map(({ content: _content, ...rest }) => rest);
      }
      if (options.includeSnippets === false) {
        chunks = chunks.map((chunk) => ({ ...chunk, snippet: "" }));
      }
      return {
        mechanism,
        chunks,
        ...stubResponse("sucesso", chunks.length ? "Busca de memória concluída." : "Nenhuma nota encontrada."),
      };
    } finally {
      closeMemoryDb(db);
    }
  }

  static async semanticSearch(
    query: string,
    options: { limit?: number } = {},
    cwd: string = process.cwd(),
    embedderOverride?: Embedder,
  ): Promise<MemorySearchResult[]> {
    const limit = Math.max(1, Math.min(options.limit ?? 10, 50));
    if (!existsSync(getMemoryDbPath(cwd))) {
      return [];
    }
    const db = openMemoryDb(cwd, { readonly: true });
    try {
      return (await hybridRows(db, query, limit, embedderOverride)).chunks;
    } catch {
      return lexicalFallback(db, query, limit);
    } finally {
      closeMemoryDb(db);
    }
  }

  static async recall(
    query: string,
    options: { limit?: number; includeSnippets?: boolean; includeContent?: boolean } = {},
    cwd: string = process.cwd(),
    embedderOverride?: Embedder,
  ): Promise<ToolResponsePayload & { chunks: MemorySearchResult[]; mechanism: string }> {
    const limit = Math.max(1, Math.min(options.limit ?? 10, 50));
    if (!existsSync(getMemoryDbPath(cwd))) {
      return VaultEngine.search(query, options, cwd);
    }
    const db = openMemoryDb(cwd, { readonly: true });
    try {
      const result = await hybridRows(db, query, limit, embedderOverride);
      let chunks = result.chunks;
      if (!options.includeContent) {
        chunks = chunks.map(({ content: _content, ...rest }) => rest);
      }
      if (options.includeSnippets === false) {
        chunks = chunks.map((chunk) => ({ ...chunk, snippet: "" }));
      }
      return {
        mechanism: result.mechanism,
        chunks,
        ...stubResponse("sucesso", chunks.length ? "Busca de memória concluída." : "Nenhuma nota encontrada."),
      };
    } catch (err) {
      const fallback = VaultEngine.search(query, options, cwd);
      return {
        ...fallback,
        ...stubResponse("parcial", err instanceof Error ? err.message : String(err), {
          limitations: ["Busca densa indisponível; fallback FTS usado."],
        }),
      };
    } finally {
      closeMemoryDb(db);
    }
  }

  static status(cwd: string = process.cwd()): MemoryStatus {
    if (!existsSync(getMemoryDbPath(cwd))) {
      return { initialized: false, staleness: "unknown", notes_count: 0, last_sync_at: null, embeddings_ready: false };
    }
    try {
      const db = openMemoryDb(cwd, { readonly: true });
      try {
        const meta = db.prepare("SELECT last_sync_at, notes_count, vault_hash FROM memory_meta WHERE id = 1").get() as
          | { last_sync_at: string | null; notes_count: number; vault_hash: string | null }
          | undefined;
        const emb = db.prepare("SELECT note_count, vault_hash FROM note_embeddings_meta WHERE id = 1").get() as
          | { note_count: number; vault_hash: string | null }
          | undefined;
        const vaultDir = getVaultDir(cwd);
        const files = walkMarkdown(vaultDir);
        const currentVaultHash = computeVaultHash(vaultDir, files);
        const staleness = meta?.vault_hash && meta.vault_hash === currentVaultHash ? "fresh" : "stale";
        return {
          initialized: true,
          staleness: meta?.last_sync_at ? staleness : "unknown",
          notes_count: meta?.notes_count ?? 0,
          last_sync_at: meta?.last_sync_at ?? null,
          embeddings_ready: Boolean(emb && emb.note_count === (meta?.notes_count ?? -1) && emb.vault_hash === meta?.vault_hash),
        };
      } finally {
        closeMemoryDb(db);
      }
    } catch (err) {
      return {
        initialized: true,
        staleness: "unknown",
        notes_count: 0,
        last_sync_at: null,
        embeddings_ready: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  static rebuild(cwd: string = process.cwd()): ToolResponsePayload {
    if (existsSync(getMemoryDbPath(cwd))) {
      rmSync(getMemoryDbPath(cwd), { force: true });
    }
    VaultEngine.init(cwd);
    return VaultEngine.sync(cwd);
  }
}

function lexicalFallback(db: Database, query: string, limit: number): MemorySearchResult[] {
  return ftsRows(db, query, limit);
}
