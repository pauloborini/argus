import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runIndex } from "../src/commands/index-cmd.js";
import { initWorkspace, getIndexDbPath } from "../src/workspace/workspace.js";
import { closeIndexDb, openIndexDb } from "../src/storage/sqlite-index-store.js";
import { quantizeInt8 } from "../src/embeddings/quantize.js";
import {
  hasEmbeddings,
  readAllEmbeddings,
  readEmbeddingsMeta,
  readSymbolsByIds,
  readSymbolsForEmbedding,
  replaceEmbeddings,
} from "../src/storage/embeddings-store.js";

describe("embeddings-store (migração v4)", () => {
  let tempDir: string | undefined;
  let originalCwd: string | undefined;

  afterEach(() => {
    if (originalCwd) {
      process.chdir(originalCwd);
      originalCwd = undefined;
    }
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  async function setupIndexed(): Promise<string> {
    originalCwd = process.cwd();
    tempDir = mkdtempSync(join(tmpdir(), "argus-emb-"));
    const file = join(tempDir, "app.ts");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "export function calculateTotal() { return 1; }\n", "utf-8");
    initWorkspace(tempDir);
    process.chdir(tempDir);
    expect(await runIndex()).toBe(0);
    return tempDir;
  }

  it("cria tabelas vazias e faz roundtrip de replace/read/meta", async () => {
    const root = await setupIndexed();
    const db = openIndexDb(getIndexDbPath(root));
    try {
      expect(hasEmbeddings(db)).toBe(false);
      expect(readEmbeddingsMeta(db)).toBeNull();

      const symbols = readSymbolsForEmbedding(db);
      expect(symbols.length).toBeGreaterThan(0);
      const target = symbols.find((s) => s.name === "calculateTotal");
      expect(target).toBeDefined();

      const { bytes, scale } = quantizeInt8(Float32Array.from([0.5, -0.5, 0.7, 0.1]));
      replaceEmbeddings(
        db,
        {
          model: "fake",
          dim: 4,
          built_at: new Date().toISOString(),
          symbol_count: 1,
          manifest_hash: "abc123",
        },
        [{ symbol_id: target!.symbol_id, bytes, scale, content_hash: "deadbeef" }],
      );

      expect(hasEmbeddings(db)).toBe(true);
      const meta = readEmbeddingsMeta(db);
      expect(meta?.model).toBe("fake");
      expect(meta?.manifest_hash).toBe("abc123");

      const rows = readAllEmbeddings(db);
      expect(rows).toHaveLength(1);
      expect(rows[0].symbol_id).toBe(target!.symbol_id);
      expect(Array.from(rows[0].bytes)).toEqual(Array.from(bytes));

      const details = readSymbolsByIds(db, [target!.symbol_id]);
      expect(details.get(target!.symbol_id)?.name).toBe("calculateTotal");
    } finally {
      closeIndexDb(db);
    }
  });
});
