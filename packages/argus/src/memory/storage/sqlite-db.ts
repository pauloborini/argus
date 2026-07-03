import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import type { Database } from "../../storage/sqlite-db.js";
import { loadBetterSqlite3 } from "../../storage/sqlite-db.js";
import { getMemoryDbPath } from "../paths.js";
import { MEMORY_SQLITE_SCHEMA_VERSION, memorySchemaSql } from "./sqlite-schema.js";

export type { Database };

export class MemoryDbSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryDbSchemaError";
  }
}

export function openMemoryDb(cwd: string = process.cwd(), options: { readonly?: boolean } = {}): Database {
  const dbPath = getMemoryDbPath(cwd);
  if (!options.readonly) {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const Sqlite = loadBetterSqlite3();
  const db = new Sqlite(dbPath, options);
  if (!options.readonly) {
    db.exec(memorySchemaSql());
    db.prepare(
      `INSERT INTO memory_meta (id, schema_version, notes_count)
       VALUES (1, ?, 0)
       ON CONFLICT(id) DO NOTHING`,
    ).run(MEMORY_SQLITE_SCHEMA_VERSION);
  }
  return db;
}

export function closeMemoryDb(db: Database): void {
  db.close();
}

