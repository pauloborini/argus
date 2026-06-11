import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runIndex } from "../src/commands/index-cmd.js";
import { runSync } from "../src/commands/sync.js";
import { readManifest } from "../src/discovery/manifest.js";
import { initWorkspace } from "../src/workspace/workspace.js";

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

  function useWorkspace(): { root: string; manifestPath: string } {
    originalCwd = process.cwd();
    tempDir = mkdtempSync(join(tmpdir(), "cortex-index-"));
    writeFileSync(join(tempDir, "a.ts"), "export const a = 1;\n", "utf-8");
    writeFileSync(join(tempDir, "b.ts"), "export const b = 2;\n", "utf-8");
    initWorkspace(tempDir);
    process.chdir(tempDir);
    return {
      root: tempDir,
      manifestPath: join(tempDir, ".cortex", "file-manifest.json"),
    };
  }

  it("index gera manifest completo", () => {
    const { manifestPath } = useWorkspace();

    expect(runIndex()).toBe(0);
    expect(existsSync(manifestPath)).toBe(true);

    const manifest = readManifest(manifestPath);
    expect(manifest?.file_count).toBe(2);
    expect(manifest?.files.map((file) => file.relative_path)).toEqual(["a.ts", "b.ts"]);
  });

  it("sync falha sem manifest prévio", () => {
    useWorkspace();
    expect(runSync()).toBe(1);
  });

  it("sync falha quando manifest está corrompido", () => {
    const { manifestPath } = useWorkspace();
    expect(runIndex()).toBe(0);
    const corrupted = {
      schema_version: "v1",
      generated_at: new Date().toISOString(),
      root_path: process.cwd(),
      file_count: 1,
      files: [{ relative_path: "a.ts", content_hash: 777, size_bytes: "19", mtime_ms: {} }],
    };
    writeFileSync(manifestPath, JSON.stringify(corrupted, null, 2) + "\n", "utf-8");
    expect(runSync()).toBe(1);
  });

  it("sync atualiza delta de adição, modificação e remoção", () => {
    const { root, manifestPath } = useWorkspace();
    expect(runIndex()).toBe(0);

    writeFileSync(join(root, "a.ts"), "export const a = 10;\n", "utf-8");
    writeFileSync(join(root, "c.ts"), "export const c = 3;\n", "utf-8");
    rmSync(join(root, "b.ts"));

    expect(runSync()).toBe(0);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
      file_count: number;
      files: Array<{ relative_path: string }>;
    };
    expect(manifest.file_count).toBe(2);
    expect(manifest.files.map((file) => file.relative_path).sort()).toEqual(["a.ts", "c.ts"]);
  });
});
