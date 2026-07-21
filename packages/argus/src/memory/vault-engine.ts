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
import { CodeIndexReader } from "./code-index-reader.js";
import { rebuildMemoryGraph } from "./memory-graph-store.js";
import { parseMarkdown } from "./markdown-parser.js";
import { getMemoryDbPath, getVaultDir, VAULT_SUBDIRS, type VaultSubdir } from "./paths.js";
import { closeMemoryDb, openMemoryDb, type Database } from "./storage/sqlite-db.js";
import { MEMORY_SQLITE_SCHEMA_VERSION } from "./storage/sqlite-schema.js";
import { isMemorySchemaV2, memoryV2NoteInsertSql } from "./storage/sqlite-v2-migrate.js";
import {
  buildV2ReadSqlFilter,
  defaultMemoryReadFilter,
  deriveReadState,
  MEMORY_NOTE_V2_SELECT,
  normalizeMemoryChunk,
  type MemoryMatchMechanism,
  type MemoryNoteV2Row,
  type MemoryReadFilter,
  type MemoryRetrievalChunk,
} from "./memory-retrieval.js";
import * as HotUpdater from "./hot-updater.js";
import { defaultDirectCaptureV2, isLegacyV1Note, normalizeV2Metadata } from "./v2-metadata.js";

const VALID_TYPES = new Set(["inbox", "decision", "meeting", "entity", "project", "reference"]);

export interface RememberOptions {
  type?: string;
  tags?: string[];
  links?: string[];
  file?: string;
  /** Injeção de embedder (testes); default tenta createEmbedder() no hot path. */
  embedder?: Embedder;
}

export type MemorySearchResult = MemoryRetrievalChunk;

export interface MemoryStatus {
  initialized: boolean;
  staleness: "fresh" | "stale" | "unknown";
  notes_count: number;
  last_sync_at: string | null;
  embeddings_ready: boolean;
  schema_version?: string | null;
  schema_v2_ready?: boolean;
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

function ftsRows(
  db: Database,
  query: string,
  limit: number,
  filter: MemoryReadFilter = defaultMemoryReadFilter(),
): MemorySearchResult[] {
  const { clause, params } = buildV2ReadSqlFilter(filter);
  const rows = db
    .prepare(
      `SELECT ${MEMORY_NOTE_V2_SELECT},
              snippet(notes_fts, 3, '', '', ' … ', 20) AS snippet,
              bm25(notes_fts) AS rank
       FROM notes_fts
       JOIN notes n ON n.id = notes_fts.note_id
       WHERE notes_fts MATCH ?
         AND ${clause}
       ORDER BY rank
       LIMIT ?`,
    )
    .all(escapeFts(query), ...params, limit) as Array<MemoryNoteV2Row & { rank: number; snippet: string }>;
  // Score-base a partir de BM25 (mais negativo = melhor); normaliza para (0,1].
  // Fatores v2 reranqueiam depois — relevância lexical controlada não depende só da posição.
  const positives = rows.map((row) => Math.max(1e-9, -row.rank));
  const maxPositive = Math.max(...positives, 1e-9);
  const chunks = rows.map((row, index) =>
    normalizeMemoryChunk(
      row,
      positives[index]! / maxPositive,
      "fts-only",
      row.snippet || row.content.slice(0, 240),
      true,
    ),
  );
  return chunks.sort((a, b) => b.score - a.score || a.note_id.localeCompare(b.note_id));
}

function readAllNoteEmbeddings(db: Database): EmbeddingRow[] {
  const rows = db.prepare("SELECT note_id, vector FROM note_embeddings").all() as Array<{
    note_id: string;
    vector: Buffer;
  }>;
  return rows.map((row) => ({ symbol_id: Number.parseInt(row.note_id.slice(0, 12), 16), bytes: blobToInt8(row.vector) }));
}

function readReadableNotePseudoIds(
  db: Database,
  filter: MemoryReadFilter = defaultMemoryReadFilter(),
): Set<number> {
  const { clause, params } = buildV2ReadSqlFilter(filter);
  const rows = db
    .prepare(`SELECT n.id AS note_id FROM notes n WHERE ${clause}`)
    .all(...params) as Array<{ note_id: string }>;
  return new Set(rows.map((row) => Number.parseInt(row.note_id.slice(0, 12), 16)));
}

function readNotesByPseudoIds(
  db: Database,
  pseudoIds: number[],
  filter: MemoryReadFilter = defaultMemoryReadFilter(),
): Map<number, MemoryNoteV2Row> {
  const { clause, params } = buildV2ReadSqlFilter(filter);
  const notes = db
    .prepare(`SELECT ${MEMORY_NOTE_V2_SELECT} FROM notes n WHERE ${clause}`)
    .all(...params) as MemoryNoteV2Row[];
  const map = new Map<number, MemoryNoteV2Row>();
  for (const note of notes) {
    const pseudo = Number.parseInt(note.note_id.slice(0, 12), 16);
    if (pseudoIds.includes(pseudo)) {
      map.set(pseudo, note);
    }
  }
  return map;
}

function buildMemoryResultsByPseudoIds(
  db: Database,
  ordered: number[],
  mechanism: MemoryMatchMechanism,
  scoreById?: Map<number, number>,
  filter: MemoryReadFilter = defaultMemoryReadFilter(),
): MemorySearchResult[] {
  const notes = readNotesByPseudoIds(db, ordered, filter);
  const chunks = ordered
    .map((id, index) => {
      const note = notes.get(id);
      return note
        ? normalizeMemoryChunk(
            note,
            scoreById?.get(id) ?? 1 / (index + 1),
            mechanism,
            note.content.slice(0, 240),
            true,
          )
        : null;
    })
    .filter((item): item is MemorySearchResult => item !== null);
  return chunks.sort((a, b) => b.score - a.score || a.note_id.localeCompare(b.note_id));
}

async function hybridRows(
  db: Database,
  query: string,
  limit: number,
  embedderOverride?: Embedder,
  filter: MemoryReadFilter = defaultMemoryReadFilter(),
): Promise<{ chunks: MemorySearchResult[]; mechanism: "hybrid-rrf" | "fts-only" }> {
  const lexical = ftsRows(db, query, Math.max(limit, 50), filter);
  const rows = readAllNoteEmbeddings(db);
  if (rows.length === 0) {
    return { chunks: lexical.slice(0, limit), mechanism: "fts-only" };
  }
  const embedder = embedderOverride ?? createEmbedder();
  const [queryVector] = await embedder.embed([`${BGE_QUERY_INSTRUCTION}${query}`]);
  const q = quantizeInt8(queryVector!);
  const readableIds = readReadableNotePseudoIds(db, filter);
  const dense = denseTopK(rows, q.bytes, Math.max(limit, 50), readableIds);
  const lexicalIds = lexical.map((hit) => Number.parseInt(hit.note_id.slice(0, 12), 16));
  const fused = reciprocalRankFusion([dense.map((hit) => hit.symbol_id), lexicalIds]).slice(0, limit);
  return {
    mechanism: "hybrid-rrf",
    chunks: buildMemoryResultsByPseudoIds(
      db,
      fused.map((item) => item.id),
      "hybrid-rrf",
      new Map(fused.map((item) => [item.id, item.score])),
      filter,
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

  static async remember(
    content: string,
    options: RememberOptions = {},
    cwd: string = process.cwd(),
  ): Promise<ToolResponsePayload> {
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
    const v2Defaults = defaultDirectCaptureV2(now);
    const finalContent = [
      "---",
      `title: ${JSON.stringify(title)}`,
      `type: ${targetType}`,
      `tags: ${yamlList(tags)}`,
      `links: ${yamlList(links)}`,
      `scope: ${v2Defaults.scope}`,
      `source: ${v2Defaults.source}`,
      `confidence: ${v2Defaults.confidence}`,
      `observed_at: ${v2Defaults.observed_at}`,
      `created_at: ${now}`,
      `updated_at: ${now}`,
      "---",
      "",
      parsed.body.trim(),
      "",
    ].join("\n");
    writeFileSync(notePath, finalContent, "utf-8");
    const vaultRel = relative(getVaultDir(cwd), notePath);
    const noteId = hashText(`${vaultRel}\n${finalContent}`).slice(0, 16);
    // Namespace import permite prova de wire parcial (spy) sem mockar o seam no retry.
    const hot = HotUpdater.hotUpdateNoteProjection(cwd, {
      absolutePath: notePath,
      rawContent: finalContent,
      vaultRelativePath: vaultRel,
    });
    if (!hot.ok) {
      return {
        note_path: vaultRel,
        note_id: noteId,
        fts_indexed: false,
        embedding_status: hot.embedding_status,
        hot_index_code: hot.code,
        ...stubResponse("parcial", "Nota persistida; indexação quente pendente.", {
          limitations: [
            hot.error ?? "E_MEMORY_HOT_INDEX_FAILED",
            "Retry idempotente: repita remember (FTS) ou argus memory embed (vetor unitário).",
          ],
        }),
      };
    }

    let embeddingStatus = hot.embedding_status;
    const limitations: string[] = [...hot.warnings];
    // Hot embed unitário same-session: nunca sync/wipe. Budget em hotUpdateNoteEmbedding.
    // ARGUS_HOT_EMBED=0: pula createEmbedder (smoke/CI sem baixar modelo); inject via options.embedder ainda roda.
    const skipDefaultHotEmbed = !options.embedder && process.env.ARGUS_HOT_EMBED === "0";
    if (embeddingStatus === "pending" && !skipDefaultHotEmbed) {
      try {
        const embedder = options.embedder ?? createEmbedder();
        embeddingStatus = await HotUpdater.hotUpdateNoteEmbedding(cwd, hot.note_id || noteId, embedder);
      } catch (err) {
        if (err instanceof EmbeddingsUnavailableError) {
          embeddingStatus = "pending";
          limitations.push(
            `${err.message} FTS disponível. Opcional: argus memory embed.`,
          );
        } else {
          embeddingStatus = "failed";
          limitations.push(
            `Embedding falhou: ${err instanceof Error ? err.message : String(err)}. FTS disponível. Opcional: argus memory embed.`,
          );
        }
      }
    }
    if (embeddingStatus === "pending") {
      limitations.push("Embedding pendente; FTS disponível. Opcional: argus memory embed.");
    } else if (embeddingStatus === "failed") {
      limitations.push("Embedding falhou; FTS disponível. Opcional: argus memory embed.");
    }
    return {
      note_path: vaultRel,
      note_id: hot.note_id || noteId,
      fts_indexed: hot.fts_indexed,
      embedding_status: embeddingStatus,
      ...stubResponse(
        "sucesso",
        "Nota capturada e indexada no cofre de memória.",
        limitations.length ? { limitations } : undefined,
      ),
    };
  }

  static sync(cwd: string = process.cwd()): ToolResponsePayload {
    VaultEngine.init(cwd);
    const vaultDir = getVaultDir(cwd);
    const files = walkMarkdown(vaultDir);
    const db = openMemoryDb(cwd);
    const syncWarnings: string[] = [];
    const codeIndex = CodeIndexReader.open(cwd);
    try {
      const tx = db.transaction(() => {
        db.exec("DELETE FROM notes_fts; DELETE FROM note_embeddings; DELETE FROM memory_relations; DELETE FROM memory_entities; DELETE FROM notes;");
        const insertNote = db.prepare(memoryV2NoteInsertSql());
        const insertFts = db.prepare("INSERT INTO notes_fts (note_id, path, title, content) VALUES (?, ?, ?, ?)");
        const graphNotes: Array<{ id: string; path: string; title: string; parsed: ReturnType<typeof parseMarkdown> }> = [];
        for (const file of files) {
          const raw = readFileSync(file, "utf-8");
          const rel = relative(vaultDir, file);
          const parsed = parseMarkdown(raw, basename(file, extname(file)));
          const body = parsed.body.trim();
          const id = hashText(`${rel}\n${raw}`).slice(0, 16);
          const observedAt = parsed.observed_at ?? parsed.updated_at ?? parsed.created_at ?? new Date().toISOString();
          const v2 = normalizeV2Metadata(parsed, {
            notePath: rel,
            observedAt,
            isLegacyV1Note: isLegacyV1Note(parsed),
          });
          if (v2.warnings.length) {
            syncWarnings.push(...v2.warnings.map((warning) => `${rel}: ${warning}`));
          }
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
            v2.scope,
            v2.source,
            v2.confidence,
            v2.observed_at,
            v2.valid_from,
            v2.valid_until,
            v2.superseded_by,
            v2.supersedes,
            v2.stale_reason,
            v2.contradiction_reason,
            v2.migrated_from_v1,
          );
          insertFts.run(id, rel, parsed.title, body);
          graphNotes.push({ id, path: rel, title: parsed.title, parsed });
        }
        syncWarnings.push(...rebuildMemoryGraph(db, cwd, graphNotes, codeIndex));
        db.prepare(
          `INSERT INTO memory_meta (id, schema_version, last_sync_at, notes_count, vault_hash)
           VALUES (1, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET schema_version = excluded.schema_version,
             last_sync_at = excluded.last_sync_at,
             notes_count = excluded.notes_count, vault_hash = excluded.vault_hash`,
        ).run(MEMORY_SQLITE_SCHEMA_VERSION, new Date().toISOString(), files.length, computeVaultHash(vaultDir, files));
      });
      tx();
      const envelope = syncWarnings.length
        ? stubResponse("parcial", "Cofre sincronizado com ajustes de metadados v2.", { limitations: syncWarnings })
        : stubResponse("sucesso", "Cofre sincronizado.");
      return { notes_count: files.length, ...envelope };
    } finally {
      codeIndex.close();
      closeMemoryDb(db);
    }
  }

  static async embed(cwd: string = process.cwd(), embedderOverride?: Embedder): Promise<ToolResponsePayload> {
    // Caminho frio/batch incremental: NÃO chama sync (wipe destrutivo). Upsert por nota;
    // remove só embeddings órfãos. Para rebuild estrutural do vault → `memory sync` explícito.
    VaultEngine.init(cwd);
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
      const existing = db.prepare("SELECT note_id, content_hash FROM note_embeddings").all() as Array<{
        note_id: string;
        content_hash: string;
      }>;
      const existingById = new Map(existing.map((row) => [row.note_id, row.content_hash]));
      const toEmbed = notes.filter((note) => existingById.get(note.id) !== note.content_hash);
      const vectors =
        toEmbed.length > 0
          ? await embedder.embed(toEmbed.map((note) => `${note.title}\n${note.content}`))
          : [];
      const tx = db.transaction(() => {
        const upsert = db.prepare(
          `INSERT INTO note_embeddings (note_id, vector, scale, dim, content_hash)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(note_id) DO UPDATE SET
             vector = excluded.vector, scale = excluded.scale, dim = excluded.dim, content_hash = excluded.content_hash`,
        );
        for (let i = 0; i < toEmbed.length; i += 1) {
          const note = toEmbed[i]!;
          const vector = vectors[i]!;
          const q = quantizeInt8(vector);
          upsert.run(note.id, int8ToBlob(q.bytes), q.scale, vector.length, note.content_hash);
        }
        db.prepare(
          "DELETE FROM note_embeddings WHERE note_id NOT IN (SELECT id FROM notes)",
        ).run();
        const noteCount = (db.prepare("SELECT COUNT(*) AS c FROM note_embeddings").get() as { c: number }).c;
        const dim =
          toEmbed.length > 0
            ? vectors[0]!.length
            : ((db.prepare("SELECT dim FROM note_embeddings LIMIT 1").get() as { dim: number } | undefined)?.dim ??
              0);
        db.prepare(
          `INSERT INTO note_embeddings_meta (id, model, dim, built_at, note_count, vault_hash)
           VALUES (1, ?, ?, ?, ?, (SELECT vault_hash FROM memory_meta WHERE id = 1))
           ON CONFLICT(id) DO UPDATE SET model = excluded.model, dim = excluded.dim,
             built_at = excluded.built_at, note_count = excluded.note_count, vault_hash = excluded.vault_hash`,
        ).run(embedder.model, dim, new Date().toISOString(), noteCount);
      });
      tx();
      return {
        note_count: notes.length,
        embedded_count: toEmbed.length,
        ...stubResponse("sucesso", "Embeddings de memória atualizados (incremental, sem wipe de sync)."),
      };
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
      const limitations: string[] = ["Busca sem embeddings; fallback FTS."];
      if (chunks.some((chunk) => chunk.stale_reason)) {
        limitations.push("Resultados incluem fatos com stale_reason.");
      }
      if (chunks.some((chunk) => chunk.contradiction_reason)) {
        limitations.push("Resultados incluem fatos com contradiction_reason.");
      }
      return {
        mechanism,
        chunks,
        ...stubResponse(
          chunks.length === 0 ? "sucesso" : "parcial",
          chunks.length ? "Busca de memória concluída (FTS)." : "Nenhuma nota encontrada.",
          chunks.length ? { limitations } : undefined,
        ),
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
      const readState = deriveReadState(chunks);
      const limitations: string[] = [];
      if (chunks.some((chunk) => chunk.stale_reason)) {
        limitations.push("Resultados incluem fatos com stale_reason.");
      }
      if (chunks.some((chunk) => chunk.contradiction_reason)) {
        limitations.push("Resultados incluem fatos com contradiction_reason.");
      }
      const responseState =
        result.mechanism === "fts-only"
          ? chunks.length === 0
            ? "sucesso"
            : "parcial"
          : readState;
      return {
        mechanism: result.mechanism,
        chunks,
        ...stubResponse(
          responseState,
          chunks.length ? "Busca de memória concluída." : "Nenhuma nota encontrada.",
          limitations.length ? { limitations } : undefined,
        ),
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
      return {
        initialized: false,
        staleness: "unknown",
        notes_count: 0,
        last_sync_at: null,
        embeddings_ready: false,
        schema_version: null,
        schema_v2_ready: false,
      };
    }
    try {
      const db = openMemoryDb(cwd, { readonly: true });
      try {
        const meta = db
          .prepare("SELECT schema_version, last_sync_at, notes_count, vault_hash FROM memory_meta WHERE id = 1")
          .get() as
          | { schema_version: string; last_sync_at: string | null; notes_count: number; vault_hash: string | null }
          | undefined;
        const emb = db.prepare("SELECT note_count, vault_hash FROM note_embeddings_meta WHERE id = 1").get() as
          | { note_count: number; vault_hash: string | null }
          | undefined;
        const vaultDir = getVaultDir(cwd);
        const files = walkMarkdown(vaultDir);
        const currentVaultHash = computeVaultHash(vaultDir, files);
        const staleness = meta?.vault_hash && meta.vault_hash === currentVaultHash ? "fresh" : "stale";
        const schemaVersion = meta?.schema_version ?? null;
        const schemaV2Ready = schemaVersion === MEMORY_SQLITE_SCHEMA_VERSION && isMemorySchemaV2(db);
        return {
          initialized: true,
          staleness: meta?.last_sync_at ? staleness : "unknown",
          notes_count: meta?.notes_count ?? 0,
          last_sync_at: meta?.last_sync_at ?? null,
          embeddings_ready: Boolean(emb && emb.note_count === (meta?.notes_count ?? -1) && emb.vault_hash === meta?.vault_hash),
          schema_version: schemaVersion,
          schema_v2_ready: schemaV2Ready,
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
        schema_version: null,
        schema_v2_ready: false,
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
