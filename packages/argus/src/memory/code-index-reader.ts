import { existsSync } from "node:fs";
import { closeIndexDb, openIndexDb } from "../storage/sqlite-index-store.js";
import { getIndexDbPath } from "../workspace/workspace.js";
import type { Database } from "../storage/sqlite-db.js";

export interface CodeRef {
  file: string;
  line: number;
  symbol: string;
}

export type CodeIndexStatus = "connected" | "unavailable" | "schema_mismatch";

export class CodeIndexReader {
  private constructor(
    private readonly db: Database | null,
    private readonly status: CodeIndexStatus,
  ) {}

  static open(cwd: string): CodeIndexReader {
    const path = getIndexDbPath(cwd);
    if (!existsSync(path)) {
      return new CodeIndexReader(null, "unavailable");
    }
    try {
      const db = openIndexDb(path, { readonly: true });
      return new CodeIndexReader(db, "connected");
    } catch {
      return new CodeIndexReader(null, "schema_mismatch");
    }
  }

  getStatus(): CodeIndexStatus {
    return this.status;
  }

  resolveSymbol(name: string, scope?: string): CodeRef[] {
    if (!this.db) {
      return [];
    }
    const like = `%${name}%`;
    const rows = this.db
      .prepare(
        `SELECT f.relative_path AS file, s.start_line AS line, s.name AS symbol
         FROM symbols s
         JOIN files f ON f.id = s.file_id
         WHERE s.name LIKE ? AND (? IS NULL OR f.relative_path LIKE ?)
         ORDER BY f.relative_path, s.start_line
         LIMIT 20`,
      )
      .all(like, scope ?? null, scope ? `%${scope}%` : null) as CodeRef[];
    return rows;
  }

  close(): void {
    if (this.db) {
      closeIndexDb(this.db);
    }
  }
}
