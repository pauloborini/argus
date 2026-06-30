import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildStructuralIndexDocument,
  writeStructuralIndexAtomic,
} from "../src/extraction/index-store.js";
import {
  closeIndexDb,
  isIndexDbPopulated,
  openIndexDb,
  readIndexMeta,
  readStructuralIndexFromDb,
} from "../src/storage/sqlite-index-store.js";
import {
  importStructuralIndexFromJson,
  tryBootstrapIndexFromLegacyJson,
} from "../src/storage/sqlite-migration.js";
import { getIndexDbPath, getStructuralIndexPath } from "../src/workspace/workspace.js";

describe("sqlite-migration", () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  function legacyJsonIndex() {
    return buildStructuralIndexDocument(
      "legacy-hash",
      [
        {
          relative_path: "legacy.ts",
          language: "typescript",
          symbols: [{ name: "legacyFn", kind: "function", start_line: 1, end_line: 1 }],
          imports: [],
          edges: [],
          parse_errors: [],
        },
      ],
      {
        typescript: {
          files_eligible: 1,
          files_parsed: 1,
          symbols: 1,
          coverage_level: "full",
        },
      },
    );
  }

  it("importStructuralIndexFromJson preserva contagens", () => {
    tempDir = mkdtempSync(join(tmpdir(), "argus-sqlite-migrate-"));
    const dbPath = join(tempDir, "index.db");
    const index = legacyJsonIndex();

    const db = openIndexDb(dbPath);
    importStructuralIndexFromJson(db, index);

    const meta = readIndexMeta(db);
    expect(meta?.file_count).toBe(1);
    expect(meta?.symbol_count).toBe(1);
    expect(meta?.migration_source).toBe("json_import");

    const loaded = readStructuralIndexFromDb(db);
    expect(loaded?.files[0]?.symbols[0]?.name).toBe("legacyFn");
    closeIndexDb(db);
  });

  it("tryBootstrapIndexFromLegacyJson importa quando DB ausente", () => {
    tempDir = mkdtempSync(join(tmpdir(), "argus-sqlite-bootstrap-"));
    mkdirSync(join(tempDir, ".argus"), { recursive: true });
    writeStructuralIndexAtomic(getStructuralIndexPath(tempDir), legacyJsonIndex());

    expect(existsSync(getIndexDbPath(tempDir))).toBe(false);
    expect(tryBootstrapIndexFromLegacyJson(tempDir)).toBe(true);
    expect(existsSync(getIndexDbPath(tempDir))).toBe(true);

    const db = openIndexDb(getIndexDbPath(tempDir), { readonly: true });
    expect(isIndexDbPopulated(db)).toBe(true);
    closeIndexDb(db);
  });
});
