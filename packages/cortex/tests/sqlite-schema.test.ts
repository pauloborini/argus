import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeIndexDb, openIndexDb } from "../src/storage/sqlite-index-store.js";
import { MIGRATION_VERSION } from "../src/storage/sqlite-schema.js";

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
});
