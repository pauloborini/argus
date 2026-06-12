import { existsSync } from "node:fs";
import type { StructuralIndex } from "../extraction/types.js";
import { getIndexDbPath } from "../workspace/workspace.js";
import {
  IndexDbCorruptedError,
  IndexDbSchemaError,
  applyDelta,
  closeIndexDb,
  isIndexDbPopulated,
  openIndexDb,
  readStructuralIndexFromDb,
  replaceFullIndex,
} from "./sqlite-index-store.js";
import type { IndexDelta } from "./sqlite-index-store.js";
import { tryBootstrapIndexFromLegacyJson } from "./sqlite-migration.js";

export { IndexDbCorruptedError, IndexDbSchemaError };

export function indexDbExists(rootPath: string): boolean {
  return existsSync(getIndexDbPath(rootPath));
}

export function persistFullStructuralIndex(rootPath: string, index: StructuralIndex): void {
  const db = openIndexDb(getIndexDbPath(rootPath));
  try {
    replaceFullIndex(db, index, { migrationSource: "pipeline" });
  } finally {
    closeIndexDb(db);
  }
}

export function persistStructuralIndexDelta(rootPath: string, delta: IndexDelta): void {
  const db = openIndexDb(getIndexDbPath(rootPath));
  try {
    applyDelta(db, delta);
  } finally {
    closeIndexDb(db);
  }
}

export function loadStructuralIndexForRead(rootPath: string): StructuralIndex | null {
  const dbPath = getIndexDbPath(rootPath);
  if (!existsSync(dbPath)) {
    tryBootstrapIndexFromLegacyJson(rootPath);
  }

  if (!existsSync(dbPath)) {
    return null;
  }

  const db = openIndexDb(dbPath, { readonly: true });
  try {
    if (!isIndexDbPopulated(db)) {
      return null;
    }
    return readStructuralIndexFromDb(db);
  } finally {
    closeIndexDb(db);
  }
}
