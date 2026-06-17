import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeIndexDb, openIndexDb } from "../src/storage/sqlite-index-store.js";
import { MIGRATION_VERSION, backfillTargetName } from "../src/storage/sqlite-schema.js";

describe("sqlite-schema", () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it("abre DB vazio e cria schema idempotente", () => {
    tempDir = mkdtempSync(join(tmpdir(), "cortex-sqlite-schema-"));
    const dbPath = join(tempDir, "index.db");

    const db = openIndexDb(dbPath);
    expect(existsSync(dbPath)).toBe(true);

    const migration = db
      .prepare("SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1")
      .get() as { version: number };
    expect(migration.version).toBe(MIGRATION_VERSION);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const tableNames = tables.map((row) => row.name);
    expect(tableNames).toContain("files");
    expect(tableNames).toContain("symbols");
    expect(tableNames).toContain("edges");
    expect(tableNames).toContain("index_meta");
    expect(tableNames).toContain("packed_handles");

    // v2 do ladder: índices de grafo presentes.
    const indexes = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name")
        .all() as Array<{ name: string }>
    ).map((row) => row.name);
    expect(indexes).toContain("idx_edges_target");
    expect(indexes).toContain("idx_edges_from_symbol");
    // v3 do ladder: coluna + índice de nome-alvo normalizado.
    expect(indexes).toContain("idx_edges_target_name");
    const edgeCols = (
      db.prepare("PRAGMA table_info(edges)").all() as Array<{ name: string }>
    ).map((row) => row.name);
    expect(edgeCols).toContain("target_name");

    closeIndexDb(db);

    const db2 = openIndexDb(dbPath);
    // Ladder grava uma linha por degrau (v1..MIGRATION_VERSION); reabrir é
    // idempotente — não adiciona linhas.
    const migration2 = db2
      .prepare("SELECT COUNT(*) AS count FROM schema_migrations")
      .get() as { count: number };
    expect(migration2.count).toBe(MIGRATION_VERSION);
    closeIndexDb(db2);
  });

  it("backfillTargetName repopula edges legadas com target_name nulo", () => {
    tempDir = mkdtempSync(join(tmpdir(), "cortex-sqlite-backfill-"));
    const db = openIndexDb(join(tempDir, "index.db"));
    db.prepare("INSERT INTO files (relative_path, language) VALUES ('a.ts', 'typescript')").run();
    const fileId = (db.prepare("SELECT id FROM files WHERE relative_path = 'a.ts'").get() as { id: number }).id;
    // Simula edges legadas (gravadas antes da v3): target_name NULL.
    db.prepare("INSERT INTO edges (file_id, kind, from_symbol, target, target_name, line) VALUES (?, 'calls', 'caller', 'obj.metodo', NULL, 1)").run(fileId);
    db.prepare("INSERT INTO edges (file_id, kind, from_symbol, target, target_name, line) VALUES (?, 'extends', 'B', 'A', NULL, 2)").run(fileId);

    backfillTargetName(db);

    const rows = db
      .prepare("SELECT target, target_name FROM edges ORDER BY id")
      .all() as Array<{ target: string; target_name: string }>;
    expect(rows[0]).toMatchObject({ target: "obj.metodo", target_name: "metodo" });
    expect(rows[1]).toMatchObject({ target: "A", target_name: "A" });
    closeIndexDb(db);
  });
});
