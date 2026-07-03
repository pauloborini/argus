import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MCP_TOOL_NAMES } from "../../src/mcp/tool-registry.js";
import { RememberArgs } from "../../src/mcp/tools/remember.js";
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

  it("remember grava defaults v2 sem novos parametros obrigatorios", () => {
    const cwd = root();
    const result = VaultEngine.remember("Conteudo simples de captura", {}, cwd);
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

  it("segunda sync nao duplica notas", () => {
    const cwd = root();
    VaultEngine.remember("Nota duplicacao", {}, cwd);
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
