import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runIndex } from "../src/commands/index-cmd.js";
import { runSync } from "../src/commands/sync.js";
import { readManifest } from "../src/discovery/manifest.js";
import * as pipeline from "../src/extraction/pipeline.js";
import { loadStructuralIndexForRead } from "../src/storage/index-persistence.js";
import { getIndexDbPath, getStructuralIndexPath, initWorkspace } from "../src/workspace/workspace.js";

describe("index e sync", () => {
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

  function useWorkspace(): { root: string; manifestPath: string; dbPath: string; legacyJsonPath: string } {
    originalCwd = process.cwd();
    tempDir = mkdtempSync(join(tmpdir(), "argus-index-"));
    writeFileSync(join(tempDir, "a.ts"), "export const a = 1;\n", "utf-8");
    writeFileSync(join(tempDir, "b.ts"), "export const b = 2;\n", "utf-8");
    initWorkspace(tempDir);
    process.chdir(tempDir);
    return {
      root: tempDir,
      manifestPath: join(tempDir, ".argus", "file-manifest.json"),
      dbPath: getIndexDbPath(tempDir),
      legacyJsonPath: getStructuralIndexPath(tempDir),
    };
  }

  it("index gera manifest e banco SQLite", async () => {
    const { manifestPath, dbPath, legacyJsonPath } = useWorkspace();

    expect(await runIndex()).toBe(0);
    expect(existsSync(manifestPath)).toBe(true);
    expect(existsSync(dbPath)).toBe(true);
    expect(existsSync(legacyJsonPath)).toBe(false);

    const manifest = readManifest(manifestPath);
    expect(manifest?.file_count).toBe(2);

    const structural = loadStructuralIndexForRead(tempDir!);
    expect(structural?.file_count).toBe(2);
    expect(structural?.symbol_count).toBeGreaterThan(0);
    expect(structural?.coverage_by_language.typescript).toBeDefined();
  });

  it("sync falha sem manifest prévio", async () => {
    useWorkspace();
    expect(await runSync()).toBe(1);
  });

  it("sync falha quando manifest está corrompido", async () => {
    const { manifestPath } = useWorkspace();
    expect(await runIndex()).toBe(0);
    const corrupted = {
      schema_version: "v1",
      generated_at: new Date().toISOString(),
      root_path: process.cwd(),
      file_count: 1,
      files: [{ relative_path: "a.ts", content_hash: 777, size_bytes: "19", mtime_ms: {} }],
    };
    writeFileSync(manifestPath, JSON.stringify(corrupted, null, 2) + "\n", "utf-8");
    expect(await runSync()).toBe(1);
  });

  it("sync reconstrói índice quando manifest existe mas SQLite está ausente", async () => {
    const { manifestPath, dbPath } = useWorkspace();
    expect(await runIndex()).toBe(0);
    expect(existsSync(manifestPath)).toBe(true);
    expect(existsSync(dbPath)).toBe(true);

    rmSync(dbPath);

    expect(await runSync()).toBe(0);
    expect(existsSync(dbPath)).toBe(true);

    const manifest = readManifest(manifestPath);
    const structural = loadStructuralIndexForRead(tempDir!);
    expect(structural?.files.map((f) => f.relative_path).sort()).toEqual(["a.ts", "b.ts"]);
    expect(structural?.file_count).toBe(manifest?.file_count);
    expect(structural?.symbol_count).toBeGreaterThan(0);
  });

  it("index não persiste manifest quando extração falha", async () => {
    const { manifestPath, dbPath } = useWorkspace();
    const spy = vi
      .spyOn(pipeline, "buildStructuralIndex")
      .mockRejectedValue(new Error("falha simulada de extração"));

    expect(await runIndex()).toBe(1);
    expect(existsSync(manifestPath)).toBe(false);
    expect(existsSync(dbPath)).toBe(false);

    spy.mockRestore();
  });

  it("sync atualiza delta no SQLite", async () => {
    const { root, manifestPath, dbPath } = useWorkspace();
    expect(await runIndex()).toBe(0);

    writeFileSync(join(root, "a.ts"), "export function alphaChanged() {}\n", "utf-8");
    writeFileSync(join(root, "c.ts"), "export const c = 3;\n", "utf-8");
    rmSync(join(root, "b.ts"));

    expect(await runSync()).toBe(0);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
      file_count: number;
      files: Array<{ relative_path: string }>;
    };
    expect(manifest.file_count).toBe(2);
    expect(manifest.files.map((file) => file.relative_path).sort()).toEqual(["a.ts", "c.ts"]);

    const structural = loadStructuralIndexForRead(root);
    expect(structural?.files.map((f) => f.relative_path).sort()).toEqual(["a.ts", "c.ts"]);
    expect(structural?.files.find((f) => f.relative_path === "a.ts")?.symbols[0]?.name).toBe(
      "alphaChanged",
    );
    expect(existsSync(dbPath)).toBe(true);
  });
});
