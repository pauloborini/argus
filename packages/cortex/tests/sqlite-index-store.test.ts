import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildStructuralIndexDocument } from "../src/extraction/index-store.js";
import {
  applyDelta,
  closeIndexDb,
  openIndexDb,
  readIndexMeta,
  readStructuralIndexFromDb,
  replaceFullIndex,
} from "../src/storage/sqlite-index-store.js";

describe("sqlite-index-store", () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  function sampleIndex() {
    return buildStructuralIndexDocument(
      "hash-abc",
      [
        {
          relative_path: "src/a.ts",
          language: "typescript",
          symbols: [
            { name: "foo", kind: "function", start_line: 1, end_line: 2, exported: true },
          ],
          imports: [{ source: "./b", symbols: ["bar"] }],
          edges: [{ kind: "imports", to: "./b", line: 1 }],
          parse_errors: [],
        },
        {
          relative_path: "src/b.ts",
          language: "typescript",
          symbols: [{ name: "bar", kind: "function", start_line: 1, end_line: 1 }],
          imports: [],
          edges: [],
          parse_errors: [],
        },
      ],
      {
        typescript: {
          files_eligible: 2,
          files_parsed: 2,
          symbols: 2,
          coverage_level: "full",
        },
      },
      ["limitação de teste"],
    );
  }

  it("round-trip replaceFullIndex + readStructuralIndexFromDb", () => {
    tempDir = mkdtempSync(join(tmpdir(), "cortex-sqlite-store-"));
    const dbPath = join(tempDir, "index.db");
    const index = sampleIndex();

    const db = openIndexDb(dbPath);
    replaceFullIndex(db, index, { migrationSource: "pipeline" });

    const meta = readIndexMeta(db);
    expect(meta?.manifest_hash).toBe("hash-abc");
    expect(meta?.file_count).toBe(2);
    expect(meta?.symbol_count).toBe(2);
    expect(meta?.extraction_limitations).toEqual(["limitação de teste"]);

    const loaded = readStructuralIndexFromDb(db);
    expect(loaded?.files.map((f) => f.relative_path).sort()).toEqual(["src/a.ts", "src/b.ts"]);
    expect(loaded?.files[0]?.imports[0]?.source).toBe("./b");
    expect(loaded?.files[0]?.edges[0]?.to).toBe("./b");
    closeIndexDb(db);
  });

  it("applyDelta upsert e remove arquivos", () => {
    tempDir = mkdtempSync(join(tmpdir(), "cortex-sqlite-delta-"));
    const dbPath = join(tempDir, "index.db");
    const db = openIndexDb(dbPath);
    replaceFullIndex(db, sampleIndex());

    applyDelta(db, {
      manifestHash: "hash-delta",
      generatedAt: new Date().toISOString(),
      coverage: {
        typescript: {
          files_eligible: 1,
          files_parsed: 1,
          symbols: 1,
          coverage_level: "full",
        },
      },
      upsertedFiles: [
        {
          relative_path: "src/a.ts",
          language: "typescript",
          symbols: [{ name: "renamed", kind: "function", start_line: 1, end_line: 1 }],
          imports: [],
          edges: [],
          parse_errors: [],
        },
      ],
      removedPaths: ["src/b.ts"],
    });

    const loaded = readStructuralIndexFromDb(db);
    expect(loaded?.files.map((f) => f.relative_path)).toEqual(["src/a.ts"]);
    expect(loaded?.files[0]?.symbols[0]?.name).toBe("renamed");
    expect(loaded?.manifest_hash).toBe("hash-delta");
    closeIndexDb(db);
  });
});
