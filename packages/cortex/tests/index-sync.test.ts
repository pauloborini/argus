import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runIndex } from "../src/commands/index-cmd.js";
import { runSync } from "../src/commands/sync.js";
import { readManifest } from "../src/discovery/manifest.js";
import { readStructuralIndex } from "../src/extraction/index-store.js";
import { getStructuralIndexPath, initWorkspace } from "../src/workspace/workspace.js";

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

  function useWorkspace(): { root: string; manifestPath: string; structuralPath: string } {
    originalCwd = process.cwd();
    tempDir = mkdtempSync(join(tmpdir(), "cortex-index-"));
    writeFileSync(join(tempDir, "a.ts"), "export const a = 1;\n", "utf-8");
    writeFileSync(join(tempDir, "b.ts"), "export const b = 2;\n", "utf-8");
    initWorkspace(tempDir);
    process.chdir(tempDir);
    return {
      root: tempDir,
      manifestPath: join(tempDir, ".cortex", "file-manifest.json"),
      structuralPath: getStructuralIndexPath(tempDir),
    };
  }

  it("index gera manifest e índice estrutural", async () => {
    const { manifestPath, structuralPath } = useWorkspace();

    expect(await runIndex()).toBe(0);
    expect(existsSync(manifestPath)).toBe(true);
    expect(existsSync(structuralPath)).toBe(true);

    const manifest = readManifest(manifestPath);
    expect(manifest?.file_count).toBe(2);

    const structural = readStructuralIndex(structuralPath);
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

  it("sync atualiza delta e índice estrutural", async () => {
    const { root, manifestPath, structuralPath } = useWorkspace();
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

    const structural = readStructuralIndex(structuralPath);
    expect(structural?.files.map((f) => f.relative_path).sort()).toEqual(["a.ts", "c.ts"]);
    expect(structural?.files.find((f) => f.relative_path === "a.ts")?.symbols[0]?.name).toBe(
      "alphaChanged",
    );
  });
});
