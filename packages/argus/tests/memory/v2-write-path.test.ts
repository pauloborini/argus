import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MCP_TOOL_NAMES } from "../../src/mcp/tool-registry.js";
import { RememberArgs } from "../../src/mcp/tools/remember.js";
import { FakeEmbedder } from "../../src/embeddings/embedder.js";
import {
  countNoteEmbeddings,
  hotUpdateNoteProjection,
  readEmbeddingNoteIds,
} from "../../src/memory/hot-updater.js";
import * as HotUpdater from "../../src/memory/hot-updater.js";
import { getMemoryDbPath } from "../../src/memory/paths.js";
import { closeMemoryDb, openMemoryDb } from "../../src/memory/storage/sqlite-db.js";
import {
  MEMORY_SQLITE_SCHEMA_VERSION_V1,
  memoryV1SchemaSql,
  migrateMemoryDbToV2,
} from "../../src/memory/storage/sqlite-v2-migrate.js";
import { MEMORY_SQLITE_SCHEMA_VERSION } from "../../src/memory/storage/sqlite-schema.js";
import { VaultEngine } from "../../src/memory/vault-engine.js";
import { normalizeV2Metadata } from "../../src/memory/v2-metadata.js";
import { parseMarkdown } from "../../src/memory/markdown-parser.js";
import { initWorkspace } from "../../src/workspace/workspace.js";
import { loadBetterSqlite3 } from "../../src/storage/sqlite-db.js";

describe("memory v2 write path (S03)", () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  function root(): string {
    tempDir = mkdtempSync(join(tmpdir(), "argus-memory-v2-"));
    initWorkspace(tempDir);
    return tempDir;
  }

  function seedV1Database(cwd: string, note?: { path: string; title: string; content: string }): void {
    const dbPath = getMemoryDbPath(cwd);
    mkdirSync(dirname(dbPath), { recursive: true });
    const Sqlite = loadBetterSqlite3();
    const db = new Sqlite(dbPath);
    db.exec(memoryV1SchemaSql());
    db.prepare(
      `INSERT INTO memory_meta (id, schema_version, notes_count) VALUES (1, ?, 0)`,
    ).run(MEMORY_SQLITE_SCHEMA_VERSION_V1);
    if (note) {
      db.prepare(
        `INSERT INTO notes (id, path, title, type, tags_json, links_json, created_at, updated_at, content, content_hash)
         VALUES (?, ?, ?, 'inbox', '[]', '[]', ?, ?, ?, ?)`,
      ).run(
        "abc123",
        note.path,
        note.title,
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
        note.content,
        "hash",
      );
      db.prepare("INSERT INTO notes_fts (note_id, path, title, content) VALUES (?, ?, ?, ?)").run(
        "abc123",
        note.path,
        note.title,
        note.content,
      );
      db.prepare("UPDATE memory_meta SET notes_count = 1 WHERE id = 1").run();
    }
    db.close();
  }

  it("migra banco v1 para v2 de forma idempotente (EVAL-S03-001)", () => {
    const cwd = root();
    seedV1Database(cwd, {
      path: "inbox/legacy.md",
      title: "Legacy note",
      content: "conteudo legado v1",
    });

    const db1 = openMemoryDb(cwd);
    try {
      const version = db1.prepare("SELECT schema_version FROM memory_meta WHERE id = 1").get() as {
        schema_version: string;
      };
      expect(version.schema_version).toBe(MEMORY_SQLITE_SCHEMA_VERSION);
      const row = db1
        .prepare("SELECT scope, source, confidence, migrated_from_v1 FROM notes WHERE path = ?")
        .get("inbox/legacy.md") as {
        scope: string;
        source: string;
        confidence: string;
        migrated_from_v1: string;
      };
      expect(row.scope).toBe("project");
      expect(row.source).toBe("v1_migration");
      expect(row.confidence).toBe("presumed");
      expect(row.migrated_from_v1).toBe("inbox/legacy.md");
    } finally {
      closeMemoryDb(db1);
    }

    const db2 = openMemoryDb(cwd);
    try {
      migrateMemoryDbToV2(db2);
      const count = db2.prepare("SELECT COUNT(*) AS c FROM notes").get() as { c: number };
      expect(count.c).toBe(1);
    } finally {
      closeMemoryDb(db2);
    }
  });

  it("nota v1 migrada permanece encontravel por recall FTS apos sync", () => {
    const cwd = root();
    VaultEngine.init(cwd);
    const notePath = join(cwd, ".argus", "memory", "vault", "inbox", "v1-note.md");
    writeFileSync(
      notePath,
      ["---", "title: Nota antiga", "type: inbox", "---", "", "palavra-chave-unica-v1", ""].join("\n"),
      "utf-8",
    );
    expect(VaultEngine.sync(cwd).state).toBe("sucesso");

    const search = VaultEngine.search("palavra-chave-unica-v1", { limit: 5 }, cwd);
    expect(search.state).toBe("parcial");
    expect(search.mechanism).toBe("fts-only");
    expect(search.chunks.length).toBeGreaterThan(0);

    const db = openMemoryDb(cwd, { readonly: true });
    try {
      const row = db
        .prepare("SELECT source, migrated_from_v1 FROM notes WHERE path = ?")
        .get("inbox/v1-note.md") as { source: string; migrated_from_v1: string };
      expect(row.source).toBe("v1_migration");
      expect(row.migrated_from_v1).toBe("inbox/v1-note.md");
    } finally {
      closeMemoryDb(db);
    }
  });

  it("remember grava defaults v2 sem novos parametros obrigatorios", async () => {
    const cwd = root();
    const result = await VaultEngine.remember("Conteudo simples de captura", {}, cwd);
    expect(result.state).toBe("sucesso");
    const inboxDir = join(cwd, ".argus", "memory", "vault", "inbox");
    const file = readdirSync(inboxDir).find((f) => f.endsWith(".md"));
    const mdFile = readFileSync(join(inboxDir, file!), "utf-8");
    expect(mdFile).toMatch(/scope: project/);
    expect(mdFile).toMatch(/source: direct_capture/);
    expect(mdFile).toMatch(/confidence: presumed/);
    expect(mdFile).toMatch(/observed_at:/);

    VaultEngine.sync(cwd);
    const db = openMemoryDb(cwd, { readonly: true });
    try {
      const note = db.prepare("SELECT scope, source FROM notes LIMIT 1").get() as {
        scope: string;
        source: string;
      };
      expect(note.scope).toBe("project");
      expect(note.source).toBe("direct_capture");
    } finally {
      closeMemoryDb(db);
    }
  });

  it("AC-5.1.1 remember de decisão persiste confidence=confirmed no SQLite (hot path)", async () => {
    const cwd = root();
    const result = await VaultEngine.remember("Decisão: usar ranking confirmed no remember", {
      type: "decision",
    }, cwd);
    expect(result.state).toBe("sucesso");
    expect(result.note_path).toMatch(/^decision\//);

    const decisionDir = join(cwd, ".argus", "memory", "vault", "decision");
    const file = readdirSync(decisionDir).find((f) => f.endsWith(".md"));
    expect(file).toBeTruthy();
    const mdFile = readFileSync(join(decisionDir, file!), "utf-8");
    expect(mdFile).toMatch(/confidence: confirmed/);
    expect(mdFile).toMatch(/type: decision/);

    // Sem sync: projeção quente já deve ter confiado no frontmatter.
    const db = openMemoryDb(cwd, { readonly: true });
    try {
      const row = db
        .prepare("SELECT type, confidence, source FROM notes WHERE id = ?")
        .get(result.note_id) as { type: string; confidence: string; source: string };
      expect(row.type).toBe("decision");
      expect(row.confidence).toBe("confirmed");
      expect(row.source).toBe("direct_capture");
    } finally {
      closeMemoryDb(db);
    }
  });

  it("AC-5.1.3 inbox presumed permanece recallável e filtros de vigência intactos", async () => {
    const cwd = root();
    const unique = `inboxvigencia_${Date.now()}`;
    const remembered = await VaultEngine.remember(`${unique} corpo inbox presumed`, { type: "inbox" }, cwd);
    expect(remembered.state).toBe("sucesso");

    const db = openMemoryDb(cwd, { readonly: true });
    try {
      const row = db
        .prepare("SELECT confidence, valid_from, valid_until, superseded_by FROM notes WHERE id = ?")
        .get(remembered.note_id) as {
        confidence: string;
        valid_from: string | null;
        valid_until: string | null;
        superseded_by: string | null;
      };
      expect(row.confidence).toBe("presumed");
      expect(row.valid_from).toBeNull();
      expect(row.valid_until).toBeNull();
      expect(row.superseded_by).toBeNull();
    } finally {
      closeMemoryDb(db);
    }

    const recalled = await VaultEngine.recall(unique, { limit: 5 }, cwd);
    expect(recalled.chunks.some((c) => c.note_id === remembered.note_id)).toBe(true);
    const hit = recalled.chunks.find((c) => c.note_id === remembered.note_id);
    expect(hit?.confidence).toBe("presumed");

    // Nota futura (valid_from) não deve vazar no filtro default de vigência.
    const futurePath = join(cwd, ".argus", "memory", "vault", "inbox", "future-vigencia.md");
    writeFileSync(
      futurePath,
      [
        "---",
        'title: "Future vigencia"',
        "type: inbox",
        "scope: project",
        "source: direct_capture",
        "confidence: presumed",
        "observed_at: 2026-01-01T00:00:00.000Z",
        "valid_from: 2099-01-01T00:00:00.000Z",
        "---",
        "",
        `${unique} future only`,
        "",
      ].join("\n"),
      "utf-8",
    );
    const hot = hotUpdateNoteProjection(cwd, {
      absolutePath: futurePath,
      rawContent: readFileSync(futurePath, "utf-8"),
      vaultRelativePath: "inbox/future-vigencia.md",
    });
    expect(hot.ok).toBe(true);
    const afterFuture = await VaultEngine.recall(unique, { limit: 10 }, cwd);
    expect(afterFuture.chunks.some((c) => c.title === "Future vigencia")).toBe(false);
    expect(afterFuture.chunks.some((c) => c.note_id === remembered.note_id)).toBe(true);
  });

  it("frontmatter v2 valido sobrescreve defaults no sync", () => {
    const cwd = root();
    VaultEngine.init(cwd);
    const notePath = join(cwd, ".argus", "memory", "vault", "decision", "custom.md");
    mkdirSync(dirname(notePath), { recursive: true });
    writeFileSync(
      notePath,
      [
        "---",
        "title: Custom",
        "type: decision",
        "scope: user",
        "source: agent_inference",
        "confidence: confirmed",
        "observed_at: 2026-06-01T10:00:00.000Z",
        "---",
        "",
        "corpo",
        "",
      ].join("\n"),
      "utf-8",
    );
    VaultEngine.sync(cwd);
    const db = openMemoryDb(cwd, { readonly: true });
    try {
      const row = db
        .prepare("SELECT scope, source, confidence, observed_at FROM notes WHERE path = ?")
        .get("decision/custom.md") as {
        scope: string;
        source: string;
        confidence: string;
        observed_at: string;
      };
      expect(row.scope).toBe("user");
      expect(row.source).toBe("agent_inference");
      expect(row.confidence).toBe("confirmed");
      expect(row.observed_at).toBe("2026-06-01T10:00:00.000Z");
    } finally {
      closeMemoryDb(db);
    }
  });

  it("frontmatter invalido usa default seguro sem derrubar sync", () => {
    const cwd = root();
    VaultEngine.init(cwd);
    const notePath = join(cwd, ".argus", "memory", "vault", "inbox", "bad-scope.md");
    writeFileSync(
      notePath,
      ["---", "title: Bad", "type: inbox", "scope: org", "---", "", "texto", ""].join("\n"),
      "utf-8",
    );
    const syncResult = VaultEngine.sync(cwd);
    expect(syncResult.state).toBe("parcial");
    expect(syncResult.limitations?.some((item) => item.includes("inbox/bad-scope.md"))).toBe(true);
    const db = openMemoryDb(cwd, { readonly: true });
    try {
      const row = db.prepare("SELECT scope FROM notes WHERE path = ?").get("inbox/bad-scope.md") as {
        scope: string;
      };
      expect(row.scope).toBe("project");
    } finally {
      closeMemoryDb(db);
    }
  });

  it("status expoe schema v2 apos migracao", () => {
    const cwd = root();
    seedV1Database(cwd);
    const db = openMemoryDb(cwd);
    closeMemoryDb(db);

    const status = VaultEngine.status(cwd);
    expect(status.schema_version).toBe(MEMORY_SQLITE_SCHEMA_VERSION);
    expect(status.schema_v2_ready).toBe(true);
    expect(status.error).toBeUndefined();
  });

  it("status degradado em DB corrompido sem apagar arquivo", () => {
    const cwd = root();
    seedV1Database(cwd);
    const dbPath = getMemoryDbPath(cwd);
    writeFileSync(dbPath, "not-a-valid-sqlite-database", "utf-8");
    expect(existsSync(dbPath)).toBe(true);

    const status = VaultEngine.status(cwd);
    expect(status.error).toBeDefined();
    expect(status.schema_v2_ready).toBe(false);
    expect(existsSync(dbPath)).toBe(true);
  });

  it("segunda sync nao duplica notas", async () => {
    const cwd = root();
    await VaultEngine.remember("Nota duplicacao", {}, cwd);
    VaultEngine.sync(cwd);
    VaultEngine.sync(cwd);
    const db = openMemoryDb(cwd, { readonly: true });
    try {
      const count = db.prepare("SELECT COUNT(*) AS c FROM notes").get() as { c: number };
      expect(count.c).toBe(1);
    } finally {
      closeMemoryDb(db);
    }
  });

  it("MCP remember args permanecem sem campos v2 obrigatorios", () => {
    const args: RememberArgs = { content: "teste" };
    expect(args).not.toHaveProperty("scope");
    expect(args).not.toHaveProperty("source");
    expect(MCP_TOOL_NAMES).toHaveLength(12);
  });

  it("nota v1 com frontmatter v2 parcial mantém defaults D2 de migração", () => {
    const cwd = root();
    VaultEngine.init(cwd);
    const notePath = join(cwd, ".argus", "memory", "vault", "inbox", "partial-v2.md");
    writeFileSync(
      notePath,
      ["---", "title: Partial", "type: inbox", "scope: user", "---", "", "texto parcial", ""].join("\n"),
      "utf-8",
    );
    VaultEngine.sync(cwd);
    const db = openMemoryDb(cwd, { readonly: true });
    try {
      const row = db
        .prepare("SELECT scope, source, migrated_from_v1 FROM notes WHERE path = ?")
        .get("inbox/partial-v2.md") as { scope: string; source: string; migrated_from_v1: string };
      expect(row.scope).toBe("user");
      expect(row.source).toBe("v1_migration");
      expect(row.migrated_from_v1).toBe("inbox/partial-v2.md");
    } finally {
      closeMemoryDb(db);
    }
  });

  it("migração interrompida retoma sem duplicar nem corromper", () => {
    const cwd = root();
    seedV1Database(cwd, {
      path: "inbox/interrupted.md",
      title: "Interrupted",
      content: "conteudo pos interrupcao",
    });
    const dbPath = getMemoryDbPath(cwd);
    const Sqlite = loadBetterSqlite3();
    const partial = new Sqlite(dbPath);
    partial.exec("ALTER TABLE notes ADD COLUMN scope TEXT NOT NULL DEFAULT 'project'");
    partial.close();

    const db = openMemoryDb(cwd);
    try {
      const meta = db.prepare("SELECT schema_version FROM memory_meta WHERE id = 1").get() as {
        schema_version: string;
      };
      expect(meta.schema_version).toBe(MEMORY_SQLITE_SCHEMA_VERSION);
      const count = db.prepare("SELECT COUNT(*) AS c FROM notes").get() as { c: number };
      expect(count.c).toBe(1);
      const row = db
        .prepare("SELECT source, migrated_from_v1 FROM notes WHERE path = ?")
        .get("inbox/interrupted.md") as { source: string; migrated_from_v1: string };
      expect(row.source).toBe("v1_migration");
      expect(row.migrated_from_v1).toBe("inbox/interrupted.md");
    } finally {
      closeMemoryDb(db);
    }

    const db2 = openMemoryDb(cwd);
    try {
      const count = db2.prepare("SELECT COUNT(*) AS c FROM notes").get() as { c: number };
      expect(count.c).toBe(1);
    } finally {
      closeMemoryDb(db2);
    }
  });
  it("normalizador aplica defaults D1 e D2", () => {
    const legacy = normalizeV2Metadata(parseMarkdown("# T\n\nb", "T"), {
      notePath: "inbox/a.md",
      observedAt: "2026-07-03T12:00:00.000Z",
      isLegacyV1Note: true,
    });
    expect(legacy.source).toBe("v1_migration");
    expect(legacy.migrated_from_v1).toBe("inbox/a.md");

    const capture = normalizeV2Metadata(parseMarkdown("# T\n\nb", "T"), {
      notePath: "inbox/b.md",
      observedAt: "2026-07-03T12:00:00.000Z",
      isLegacyV1Note: false,
    });
    expect(capture.source).toBe("direct_capture");
    expect(capture.migrated_from_v1).toBeNull();
  });
});

describe("memory hot-update (S5 / Plano 4)", () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  function root(): string {
    tempDir = mkdtempSync(join(tmpdir(), "argus-hot-update-"));
    initWorkspace(tempDir);
    return tempDir;
  }

  it("AC-3.1.1/AC-4.1.1 remember→recall FTS same-process; embedding pending sem inject", async () => {
    const cwd = root();
    const syncSpy = vi.spyOn(VaultEngine, "sync");
    const unique = `hotfact-${Date.now()}-xyzzy`;
    // Vitest seta ARGUS_HOT_EMBED=0 → sem FakeEmbedder o status fica pending (coerente).
    const remembered = await VaultEngine.remember(`Decisão quente: ${unique}`, { type: "decision" }, cwd);
    expect(remembered.state).toBe("sucesso");
    expect(remembered.fts_indexed).toBe(true);
    expect(remembered.embedding_status).toBe("pending");
    expect(["updated", "pending", "failed"]).toContain(remembered.embedding_status);
    expect(JSON.stringify(remembered.limitations ?? [])).toMatch(/memory embed/i);
    expect(JSON.stringify(remembered)).not.toMatch(/memory sync/i);
    expect(syncSpy).not.toHaveBeenCalled();

    const recalled = await VaultEngine.recall(unique, { limit: 5 }, cwd);
    expect(recalled.chunks.some((c) => c.snippet.includes(unique) || c.title.includes("Decisão") || (c.content ?? "").includes(unique))).toBe(
      true,
    );
    expect(syncSpy).not.toHaveBeenCalled();
    syncSpy.mockRestore();
  });

  it("AC-4.1.1: remember via dispatcher concise expõe embedding_status (H5)", async () => {
    const { buildToolResponseAsync } = await import("../../src/mcp/tools/response.js");
    const cwd = root();
    const unique = `concise-embed-${Date.now()}-zzz`;
    const payload = await buildToolResponseAsync("remember", cwd, {
      content: `Decisão concise: ${unique}`,
      type: "decision",
      response_format: "concise",
    });
    expect(payload.state).toBe("sucesso");
    expect(["updated", "pending", "failed"]).toContain(payload.embedding_status);
    expect(payload.embedding_status).toBe("pending");
    expect(payload.confidence).toBeUndefined();
    expect(payload.staleness_hint).toBeUndefined();
    // Limitations cosméticas (sem E_*) somem; embedding_status é o sinal.
    const limitations = payload.limitations as string[] | undefined;
    if (limitations) {
      expect(limitations.every((item) => /^[EW]_[A-Z0-9_]+\b/.test(item))).toBe(true);
    }
  });

  it("AC-4.1.1 S5 MCP remember→recall sem sync (Client+Server reais)", async () => {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const { createMcpServer } = await import("../../src/mcp/server.js");

    const cwd = root();
    const originalCwd = process.cwd();
    process.chdir(cwd);
    const syncSpy = vi.spyOn(VaultEngine, "sync");
    try {
      const server = createMcpServer({ autoSync: false, listedToolsEnv: "all" });
      const client = new Client({ name: "test-hot", version: "0" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

      const unique = `mcp-hot-${Date.now()}-quux`;
      const rememberRes = await client.callTool({
        name: "remember",
        arguments: { content: `Fato MCP quente ${unique}`, type: "decision" },
      });
      expect(rememberRes.isError).not.toBe(true);
      const rememberPayload = JSON.parse(
        (rememberRes.content as Array<{ type: string; text: string }>)[0]!.text,
      ) as { state: string; fts_indexed?: boolean; embedding_status?: string };
      expect(rememberPayload.state).toBe("sucesso");
      expect(rememberPayload.fts_indexed).toBe(true);
      expect(["updated", "pending", "failed"]).toContain(rememberPayload.embedding_status);

      const recallRes = await client.callTool({
        name: "recall",
        arguments: { query: unique, limit: 5 },
      });
      expect(recallRes.isError).not.toBe(true);
      const recallPayload = JSON.parse(
        (recallRes.content as Array<{ type: string; text: string }>)[0]!.text,
      ) as { chunks: Array<{ snippet?: string; content?: string; title?: string }> };
      const hit = recallPayload.chunks.some(
        (c) =>
          (c.snippet ?? "").includes(unique) ||
          (c.content ?? "").includes(unique) ||
          (c.title ?? "").includes("Fato MCP"),
      );
      expect(hit).toBe(true);
      expect(syncSpy).not.toHaveBeenCalled();
      await client.close();
    } finally {
      syncSpy.mockRestore();
      process.chdir(originalCwd);
    }
  });

  it("AC-4.1.2 hot-update não faz wipe global nem remove embeddings alheios", async () => {
    const cwd = root();
    VaultEngine.init(cwd);
    const inbox = join(cwd, ".argus", "memory", "vault", "inbox");
    mkdirSync(inbox, { recursive: true });
    const noteA = [
      "---",
      'title: "Alpha keep"',
      "type: inbox",
      "scope: project",
      "source: direct_capture",
      "confidence: presumed",
      "observed_at: 2026-01-01T00:00:00.000Z",
      "---",
      "",
      "alpha body keep",
      "",
    ].join("\n");
    const noteB = [
      "---",
      'title: "Beta keep"',
      "type: inbox",
      "scope: project",
      "source: direct_capture",
      "confidence: presumed",
      "observed_at: 2026-01-01T00:00:00.000Z",
      "---",
      "",
      "beta body keep",
      "",
    ].join("\n");
    writeFileSync(join(inbox, "alpha-keep.md"), noteA, "utf-8");
    writeFileSync(join(inbox, "beta-keep.md"), noteB, "utf-8");
    expect(VaultEngine.sync(cwd).state).toBe("sucesso");

    const dbSeed = openMemoryDb(cwd);
    try {
      const notes = dbSeed.prepare("SELECT id, content_hash FROM notes ORDER BY path").all() as Array<{
        id: string;
        content_hash: string;
      }>;
      expect(notes.length).toBe(2);
      const insert = dbSeed.prepare(
        "INSERT INTO note_embeddings (note_id, vector, scale, dim, content_hash) VALUES (?, ?, ?, ?, ?)",
      );
      for (const note of notes) {
        insert.run(note.id, Buffer.alloc(8, 1), 1, 8, note.content_hash);
      }
    } finally {
      closeMemoryDb(dbSeed);
    }

    const beforeIds = readEmbeddingNoteIds(cwd);
    expect(beforeIds.length).toBe(2);
    const beforeCount = countNoteEmbeddings(cwd);

    const syncSpy = vi.spyOn(VaultEngine, "sync");
    const third = await VaultEngine.remember("Nota gamma hot only xyzzyunique", { type: "decision" }, cwd);
    expect(third.state).toBe("sucesso");
    expect(syncSpy).not.toHaveBeenCalled();
    syncSpy.mockRestore();

    const afterIds = readEmbeddingNoteIds(cwd);
    expect(afterIds).toEqual(beforeIds);
    expect(countNoteEmbeddings(cwd)).toBe(beforeCount);

    const db = openMemoryDb(cwd, { readonly: true });
    try {
      const notes = (db.prepare("SELECT COUNT(*) AS c FROM notes").get() as { c: number }).c;
      expect(notes).toBe(3);
      const fts = (db.prepare("SELECT COUNT(*) AS c FROM notes_fts").get() as { c: number }).c;
      expect(fts).toBe(3);
    } finally {
      closeMemoryDb(db);
    }
  });

  it("AC-4.1.3 falha de projeção é acionável; retry converge sem duplicar FTS", async () => {
    const cwd = root();
    const missing = hotUpdateNoteProjection(cwd, {
      absolutePath: join(cwd, ".argus", "memory", "vault", "inbox", "missing-note.md"),
    });
    expect(missing.ok).toBe(false);
    expect(missing.code).toBe("E_MEMORY_HOT_NOTE_MISSING");
    expect(missing.error).toMatch(/E_MEMORY_HOT_NOTE_MISSING|Retry/i);

    const remembered = await VaultEngine.remember("Retry idempotente token-zzz", { type: "inbox" }, cwd);
    expect(remembered.state).toBe("sucesso");
    const notePath = join(cwd, ".argus", "memory", "vault", (remembered.note_path as string));
    const raw = readFileSync(notePath, "utf-8");

    const first = hotUpdateNoteProjection(cwd, {
      absolutePath: notePath,
      rawContent: raw,
      vaultRelativePath: remembered.note_path as string,
    });
    const second = hotUpdateNoteProjection(cwd, {
      absolutePath: notePath,
      rawContent: raw,
      vaultRelativePath: remembered.note_path as string,
    });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.note_id).toBe(first.note_id);

    const db = openMemoryDb(cwd, { readonly: true });
    try {
      const notes = (db.prepare("SELECT COUNT(*) AS c FROM notes").get() as { c: number }).c;
      const fts = (db.prepare("SELECT COUNT(*) AS c FROM notes_fts").get() as { c: number }).c;
      expect(notes).toBe(1);
      expect(fts).toBe(1);
    } finally {
      closeMemoryDb(db);
    }
  });

  it("AC-4.1.3 remember→parcial quando projeção falha; retry real indexa sem duplicar", async () => {
    const cwd = root();
    // Stub só a 1ª projeção para exercitar o wire de remember; Markdown já foi gravado.
    // Retry seguinte usa hotUpdateNoteProjection real (S5) — sem mock do seam no retry.
    const spy = vi.spyOn(HotUpdater, "hotUpdateNoteProjection").mockReturnValueOnce({
      ok: false,
      note_id: "",
      path: "inbox/stub.md",
      fts_indexed: false,
      embedding_status: "skipped",
      warnings: [],
      code: "E_MEMORY_HOT_INDEX_FAILED",
      error: "E_MEMORY_HOT_INDEX_FAILED: falha simulada para prova de wire. Retry idempotente.",
    });
    try {
      const remembered = await VaultEngine.remember("Parcial hot wire token-aaa", { type: "inbox" }, cwd);
      expect(remembered.state).toBe("parcial");
      expect(remembered.fts_indexed).toBe(false);
      expect(remembered.hot_index_code).toBe("E_MEMORY_HOT_INDEX_FAILED");
      expect(String((remembered.limitations as string[] | undefined)?.[0] ?? "")).toMatch(
        /E_MEMORY_HOT_INDEX_FAILED/,
      );
      const notePath = join(cwd, ".argus", "memory", "vault", remembered.note_path as string);
      expect(existsSync(notePath)).toBe(true);
      const raw = readFileSync(notePath, "utf-8");
      spy.mockRestore();

      const retry = hotUpdateNoteProjection(cwd, {
        absolutePath: notePath,
        rawContent: raw,
        vaultRelativePath: remembered.note_path as string,
      });
      expect(retry.ok).toBe(true);
      expect(retry.fts_indexed).toBe(true);

      const again = hotUpdateNoteProjection(cwd, {
        absolutePath: notePath,
        rawContent: raw,
        vaultRelativePath: remembered.note_path as string,
      });
      expect(again.ok).toBe(true);
      expect(again.note_id).toBe(retry.note_id);

      const db = openMemoryDb(cwd, { readonly: true });
      try {
        const notes = (db.prepare("SELECT COUNT(*) AS c FROM notes").get() as { c: number }).c;
        const fts = (db.prepare("SELECT COUNT(*) AS c FROM notes_fts").get() as { c: number }).c;
        expect(notes).toBe(1);
        expect(fts).toBe(1);
      } finally {
        closeMemoryDb(db);
      }
    } finally {
      spy.mockRestore();
    }
  });

  it("AC-3.1.1/3.1.2 remember+FakeEmbedder → embedding updated e hybrid sem sync", async () => {
    const cwd = root();
    const syncSpy = vi.spyOn(VaultEngine, "sync");
    const unique = `hotembed-${Date.now()}-quux`;
    const remembered = await VaultEngine.remember(`Fato densavel ${unique}`, {
      type: "decision",
      embedder: new FakeEmbedder(),
    }, cwd);
    expect(remembered.state).toBe("sucesso");
    expect(remembered.fts_indexed).toBe(true);
    expect(["updated", "unchanged"]).toContain(remembered.embedding_status);
    expect(JSON.stringify(remembered)).not.toMatch(/memory sync/i);
    expect(syncSpy).not.toHaveBeenCalled();

    const recalled = await VaultEngine.recall(unique, { limit: 5 }, cwd, new FakeEmbedder());
    expect(recalled.chunks.some((c) => (c.content ?? c.snippet ?? "").includes(unique) || c.title.includes("Fato"))).toBe(
      true,
    );
    expect(recalled.mechanism).toBe("hybrid-rrf");
    expect(syncSpy).not.toHaveBeenCalled();
    syncSpy.mockRestore();
  });

  it("AC-3.1.3 remember+hot embed preserva IDs de embeddings pré-existentes", async () => {
    const cwd = root();
    VaultEngine.init(cwd);
    const inbox = join(cwd, ".argus", "memory", "vault", "inbox");
    mkdirSync(inbox, { recursive: true });
    for (const [name, body] of [
      ["alpha.md", "alpha keep body"],
      ["beta.md", "beta keep body"],
    ] as const) {
      writeFileSync(
        join(inbox, name),
        [
          "---",
          `title: "${name}"`,
          "type: inbox",
          "scope: project",
          "source: direct_capture",
          "confidence: presumed",
          "observed_at: 2026-01-01T00:00:00.000Z",
          "---",
          "",
          body,
          "",
        ].join("\n"),
        "utf-8",
      );
    }
    expect(VaultEngine.sync(cwd).state).toBe("sucesso");
    expect((await VaultEngine.embed(cwd, new FakeEmbedder())).state).toBe("sucesso");
    const beforeIds = readEmbeddingNoteIds(cwd);
    expect(beforeIds.length).toBe(2);

    const syncSpy = vi.spyOn(VaultEngine, "sync");
    const third = await VaultEngine.remember("Nota gamma densavel xyzzyunique", {
      type: "decision",
      embedder: new FakeEmbedder(),
    }, cwd);
    expect(third.state).toBe("sucesso");
    expect(third.embedding_status).toBe("updated");
    expect(syncSpy).not.toHaveBeenCalled();
    syncSpy.mockRestore();

    const afterIds = readEmbeddingNoteIds(cwd);
    for (const id of beforeIds) {
      expect(afterIds).toContain(id);
    }
    expect(afterIds.length).toBeGreaterThanOrEqual(beforeIds.length);
  });

  it("AC-3.2.1 remember parcial/sucesso nunca sugere memory sync", async () => {
    const cwd = root();
    const ok = await VaultEngine.remember("Sem sync no hint", { type: "inbox" }, cwd);
    expect(ok.state).toBe("sucesso");
    expect(JSON.stringify(ok.limitations ?? [])).not.toMatch(/memory sync/i);
    expect(String(ok.message ?? "")).not.toMatch(/memory sync/i);

    const spy = vi.spyOn(HotUpdater, "hotUpdateNoteProjection").mockReturnValueOnce({
      ok: false,
      note_id: "",
      path: "inbox/stub.md",
      fts_indexed: false,
      embedding_status: "skipped",
      warnings: [],
      code: "E_MEMORY_HOT_INDEX_FAILED",
      error: "E_MEMORY_HOT_INDEX_FAILED: falha simulada.",
    });
    try {
      const parcial = await VaultEngine.remember("Parcial sem sync hint", { type: "inbox" }, cwd);
      expect(parcial.state).toBe("parcial");
      expect(JSON.stringify(parcial.limitations ?? [])).not.toMatch(/memory sync/i);
      expect(JSON.stringify(parcial.limitations ?? [])).toMatch(/memory embed/i);
    } finally {
      spy.mockRestore();
    }
  });

  it("AC-3.2 embed incremental preserva IDs e não chama sync/wipe", async () => {
    const cwd = root();
    VaultEngine.init(cwd);
    const inbox = join(cwd, ".argus", "memory", "vault", "inbox");
    mkdirSync(inbox, { recursive: true });
    for (const [name, body] of [
      ["keep-a.md", "alpha embed keep"],
      ["keep-b.md", "beta embed keep"],
    ] as const) {
      writeFileSync(
        join(inbox, name),
        [
          "---",
          `title: "${name}"`,
          "type: inbox",
          "scope: project",
          "source: direct_capture",
          "confidence: presumed",
          "observed_at: 2026-01-01T00:00:00.000Z",
          "---",
          "",
          body,
          "",
        ].join("\n"),
        "utf-8",
      );
    }
    expect(VaultEngine.sync(cwd).state).toBe("sucesso");
    expect((await VaultEngine.embed(cwd, new FakeEmbedder())).state).toBe("sucesso");
    const beforeIds = readEmbeddingNoteIds(cwd);
    expect(beforeIds.length).toBe(2);

    const syncSpy = vi.spyOn(VaultEngine, "sync");
    const second = await VaultEngine.embed(cwd, new FakeEmbedder());
    expect(second.state).toBe("sucesso");
    expect(second.embedded_count).toBe(0);
    expect(syncSpy).not.toHaveBeenCalled();
    expect(readEmbeddingNoteIds(cwd)).toEqual(beforeIds);

    writeFileSync(
      join(inbox, "keep-c.md"),
      [
        "---",
        'title: "keep-c.md"',
        "type: inbox",
        "scope: project",
        "source: direct_capture",
        "confidence: presumed",
        "observed_at: 2026-01-01T00:00:00.000Z",
        "---",
        "",
        "gamma embed keep",
        "",
      ].join("\n"),
      "utf-8",
    );
    // Hot projection coloca a 3ª nota no SQLite sem sync (que wipearia embeddings).
    const notePath = join(inbox, "keep-c.md");
    const hot = hotUpdateNoteProjection(cwd, {
      absolutePath: notePath,
      rawContent: readFileSync(notePath, "utf-8"),
      vaultRelativePath: "inbox/keep-c.md",
    });
    expect(hot.ok).toBe(true);

    const third = await VaultEngine.embed(cwd, new FakeEmbedder());
    expect(third.state).toBe("sucesso");
    expect(third.embedded_count).toBe(1);
    expect(syncSpy).not.toHaveBeenCalled();
    const afterIds = readEmbeddingNoteIds(cwd);
    for (const id of beforeIds) {
      expect(afterIds).toContain(id);
    }
    expect(afterIds.length).toBe(3);
    syncSpy.mockRestore();
  });
});
