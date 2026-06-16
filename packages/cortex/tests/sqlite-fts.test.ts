import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildStructuralIndexDocument } from "../src/extraction/index-store.js";
import {
  closeIndexDb,
  openIndexDb,
  replaceFullIndex,
  searchFtsInternal,
} from "../src/storage/sqlite-index-store.js";

describe("sqlite-fts", () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it("searchFtsInternal encontra símbolo por nome e path", () => {
    tempDir = mkdtempSync(join(tmpdir(), "cortex-sqlite-fts-"));
    const dbPath = join(tempDir, "index.db");
    const index = buildStructuralIndexDocument(
      "fts-hash",
      [
        {
          relative_path: "pkg/service.ts",
          language: "typescript",
          symbols: [
            { name: "calculateTotal", kind: "function", start_line: 10, end_line: 20 },
            { name: "helper", kind: "function", start_line: 22, end_line: 25 },
          ],
          imports: [],
          edges: [],
          parse_errors: [],
        },
      ],
      {
        typescript: {
          files_eligible: 1,
          files_parsed: 1,
          symbols: 2,
          coverage_level: "full",
        },
      },
    );

    const db = openIndexDb(dbPath);
    replaceFullIndex(db, index);

    const byName = searchFtsInternal(db, "calculateTotal");
    expect(byName.length).toBeGreaterThan(0);
    expect(byName[0]?.name).toBe("calculateTotal");

    const byPath = searchFtsInternal(db, "service");
    expect(byPath.some((hit) => hit.relative_path === "pkg/service.ts")).toBe(true);

    const byKind = searchFtsInternal(db, "function");
    expect(byKind.length).toBeGreaterThan(0);

    closeIndexDb(db);
  });
});
