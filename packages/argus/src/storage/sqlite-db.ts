import { createRequire } from "node:module";
import type { Database } from "better-sqlite3";

const require = createRequire(import.meta.url);

export type { Database };

export class SqliteUnavailableError extends Error {
  constructor(
    message = "E_SQLITE_UNAVAILABLE: better-sqlite3 não instalado ou falhou ao carregar. Execute npm install no pacote argus.",
  ) {
    super(message);
    this.name = "SqliteUnavailableError";
  }
}

export class IndexDbCorruptedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IndexDbCorruptedError";
  }
}

export class IndexDbSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IndexDbSchemaError";
  }
}

interface BetterSqlite3Module {
  new (filename: string, options?: { readonly?: boolean }): Database;
}

export function loadBetterSqlite3(): BetterSqlite3Module {
  try {
    return require("better-sqlite3") as BetterSqlite3Module;
  } catch {
    throw new SqliteUnavailableError();
  }
}
