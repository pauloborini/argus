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
  readStructuralIndexMetaFromDb,
  replaceFullIndex,
} from "./sqlite-index-store.js";
import type { IndexDelta } from "./sqlite-index-store.js";
import { tryBootstrapIndexFromLegacyJson } from "./sqlite-migration.js";

export { IndexDbCorruptedError, IndexDbSchemaError };

/** Contador de full-load estrutural (S7). Só incrementa em `loadStructuralIndexForRead`. */
let fullStructuralLoadCount = 0;
/** Contador de meta-load (`files: []`). Distingue retrieve sem envelope de envelope lite. */
let structuralMetaLoadCount = 0;

export function getFullStructuralLoadCount(): number {
  return fullStructuralLoadCount;
}

export function getStructuralMetaLoadCount(): number {
  return structuralMetaLoadCount;
}

export function resetFullStructuralLoadCount(): void {
  fullStructuralLoadCount = 0;
}

export function resetStructuralMetaLoadCount(): void {
  structuralMetaLoadCount = 0;
}

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

export function persistStructuralIndexDelta(
  rootPath: string,
  delta: IndexDelta,
  options?: {
    resolveMeta?: (db: import("./sqlite-db.js").Database) => {
      coverage: IndexDelta["coverage"];
      extractionLimitations: string[];
    };
  },
): void {
  const db = openIndexDb(getIndexDbPath(rootPath));
  try {
    applyDelta(db, delta, options);
  } finally {
    closeIndexDb(db);
  }
}

export function loadStructuralIndexForRead(rootPath: string): StructuralIndex | null {
  fullStructuralLoadCount += 1;
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

/**
 * Como {@link loadStructuralIndexForRead}, mas meta-only (`files: []`): não
 * materializa o grafo. Caminho de `search`/`files`, que resolvem cobertura e
 * tree por query alvo em vez do full-load.
 */
export function loadStructuralMetaForRead(rootPath: string): StructuralIndex | null {
  structuralMetaLoadCount += 1;
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
    return readStructuralIndexMetaFromDb(db);
  } finally {
    closeIndexDb(db);
  }
}
