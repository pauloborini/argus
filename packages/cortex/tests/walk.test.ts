import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverFiles } from "../src/discovery/walk.js";

describe("discovery walk", () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  function createFixture(): string {
    tempDir = mkdtempSync(join(tmpdir(), "cortex-walk-"));
    mkdirSync(join(tempDir, "src"), { recursive: true });
    mkdirSync(join(tempDir, "node_modules", "pkg"), { recursive: true });
    mkdirSync(join(tempDir, ".git", "objects"), { recursive: true });
    writeFileSync(join(tempDir, "src", "main.ts"), "export const ok = true;\n", "utf-8");
    writeFileSync(join(tempDir, "src", "bundle.min.js"), "noop", "utf-8");
    writeFileSync(join(tempDir, "node_modules", "pkg", "index.js"), "ignored", "utf-8");
    return tempDir;
  }

  it("retorna apenas arquivos elegíveis", () => {
    const root = createFixture();
    const result = discoverFiles(root);
    expect(result.files.map((file) => file.relative_path)).toEqual(["src/main.ts"]);
    expect(result.limitations).toEqual([]);
  });

  it("marca limitação para arquivo acima do tamanho máximo", () => {
    const root = createFixture();
    writeFileSync(join(root, "src", "big.txt"), "x".repeat(128), "utf-8");
    const result = discoverFiles(root, { max_file_size_bytes: 64 });
    expect(result.files.map((file) => file.relative_path)).toEqual(["src/main.ts"]);
    expect(result.limitations.some((item) => item.code === "MAX_FILE_SIZE")).toBe(true);
  });

  it("marca limitação quando atinge limite de contagem", () => {
    const root = createFixture();
    writeFileSync(join(root, "src", "a.ts"), "a", "utf-8");
    writeFileSync(join(root, "src", "b.ts"), "b", "utf-8");
    const result = discoverFiles(root, { max_file_count: 2 });
    expect(result.files).toHaveLength(2);
    expect(result.limitations.some((item) => item.code === "MAX_FILE_COUNT")).toBe(true);
  });
});
