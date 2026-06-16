import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runIndex } from "../src/commands/index-cmd.js";
import { buildToolStub } from "../src/mcp/tools/stubs.js";
import { initWorkspace } from "../src/workspace/workspace.js";

describe("files stub com índice estrutural", () => {
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

  function setupWorkspace(): string {
    originalCwd = process.cwd();
    tempDir = mkdtempSync(join(tmpdir(), "cortex-files-"));
    writeFileSync(join(tempDir, "app.ts"), "export function app() {}\n", "utf-8");
    initWorkspace(tempDir);
    process.chdir(tempDir);
    return tempDir;
  }

  it("files parcial sem índice estrutural", () => {
    const root = setupWorkspace();
    const payload = buildToolStub("files", root);
    expect(payload.state).toBe("parcial");
    expect(payload.tree).toEqual([]);
  });

  it("files retorna tree com symbol_counts após index", async () => {
    const root = setupWorkspace();
    expect(await runIndex()).toBe(0);
    const payload = buildToolStub("files", root);
    expect(payload.state).toBe("sucesso");
    const tree = payload.tree as Array<{ path: string; symbol_counts?: { total: number } }>;
    expect(tree.length).toBeGreaterThan(0);
    expect(tree[0]?.symbol_counts?.total).toBeGreaterThan(0);
    expect((payload.languages as string[]).includes("typescript")).toBe(true);
  });

  it("files aceita filtro por pattern e profundidade", async () => {
    const root = setupWorkspace();
    writeFileSync(join(root, "nested.ts"), "export function nested() {}\n", "utf-8");
    expect(await runIndex()).toBe(0);

    const payload = buildToolStub("files", root, { pattern: "app", max_depth: 0 });
    const tree = payload.tree as Array<{ path: string }>;
    expect(tree).toHaveLength(1);
    expect(tree[0]?.path).toBe("app.ts");
  });
});
