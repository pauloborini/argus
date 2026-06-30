import { existsSync } from "node:fs";
import { readStructuralIndex } from "../extraction/index-store.js";
import type { StructuralIndex } from "../extraction/types.js";
import { getIndexDbPath, getStructuralIndexPath } from "../workspace/workspace.js";
import type { Database } from "./sqlite-db.js";
import {
  closeIndexDb,
  isIndexDbPopulated,
  openIndexDb,
  replaceFullIndex,
} from "./sqlite-index-store.js";

/** Import one-shot do JSON legado S05 — não usar como write path do pipeline (PRD D8). */
export function importStructuralIndexFromJson(db: Database, index: StructuralIndex): void {
  replaceFullIndex(db, index, { migrationSource: "json_import" });
}

export function tryBootstrapIndexFromLegacyJson(rootPath: string): boolean {
  const dbPath = getIndexDbPath(rootPath);
  const jsonPath = getStructuralIndexPath(rootPath);

  if (!existsSync(jsonPath)) {
    return false;
  }

  const index = readStructuralIndex(jsonPath);
  if (!index) {
    return false;
  }

  const dbExists = existsSync(dbPath);
  if (dbExists) {
    const db = openIndexDb(dbPath);
    try {
      if (isIndexDbPopulated(db)) {
        return false;
      }
      importStructuralIndexFromJson(db, index);
      return true;
    } finally {
      closeIndexDb(db);
    }
  }

  const db = openIndexDb(dbPath);
  try {
    importStructuralIndexFromJson(db, index);
    return true;
  } finally {
    closeIndexDb(db);
  }
}
