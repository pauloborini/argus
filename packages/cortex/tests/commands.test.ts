import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runIndex } from "../src/commands/index-cmd.js";
import { runStatus } from "../src/commands/status.js";
import { runServeMcp } from "../src/commands/serve.js";
import { runSync } from "../src/commands/sync.js";
import { initWorkspace } from "../src/workspace/workspace.js";

describe("commands lifecycle", () => {
  let tempDir: string;
  let originalCwd: string;

  afterEach(() => {
    process.chdir(originalCwd);
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  function useEmptyDir(): void {
    originalCwd = process.cwd();
    tempDir = mkdtempSync(join(tmpdir(), "cortex-cmd-"));
    process.chdir(tempDir);
  }

  it("index falha sem workspace com exit 1", () => {
    useEmptyDir();
    expect(runIndex()).toBe(1);
  });

  it("sync falha sem workspace com exit 1", () => {
    useEmptyDir();
    expect(runSync()).toBe(1);
  });

  it("serve --mcp falha sem workspace com exit 1", async () => {
    useEmptyDir();
    await expect(runServeMcp()).resolves.toBe(1);
  });

  it("status retorna 1 sem workspace", () => {
    useEmptyDir();
    expect(runStatus()).toBe(1);
  });

  it("status retorna 0 com workspace preparado", () => {
    useEmptyDir();
    initWorkspace(tempDir);
    expect(runStatus()).toBe(0);
  });
});
