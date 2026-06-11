import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildStructuralIndexDocument,
  readStructuralIndex,
  StructuralIndexCorruptedError,
  writeStructuralIndexAtomic,
} from "../src/extraction/index-store.js";

describe("index-store", () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it("round-trip do índice estrutural", () => {
    tempDir = mkdtempSync(join(tmpdir(), "cortex-struct-"));
    const indexPath = join(tempDir, "structural-index.json");
    const index = buildStructuralIndexDocument(
      "abc123",
      [
        {
          relative_path: "a.ts",
          language: "typescript",
          symbols: [{ name: "foo", kind: "function", start_line: 1, end_line: 2 }],
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

    writeStructuralIndexAtomic(indexPath, index);
    expect(existsSync(indexPath)).toBe(true);

    const loaded = readStructuralIndex(indexPath);
    expect(loaded?.manifest_hash).toBe("abc123");
    expect(loaded?.files[0]?.symbols[0]?.name).toBe("foo");
  });

  it("detecta índice corrompido", () => {
    tempDir = mkdtempSync(join(tmpdir(), "cortex-struct-bad-"));
    const indexPath = join(tempDir, "structural-index.json");
    writeFileSync(indexPath, JSON.stringify({ invalid: true }), "utf-8");

    expect(() => readStructuralIndex(indexPath)).toThrow(StructuralIndexCorruptedError);
  });
});
