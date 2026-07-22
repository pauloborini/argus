import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runDiffImpact } from "../src/commands/diff-impact.js";
import { runIndex } from "../src/commands/index-cmd.js";
import { runFiles } from "../src/commands/files.js";
import { runExplore } from "../src/commands/explore.js";
import { runImpact } from "../src/commands/impact.js";
import { runPackContext } from "../src/commands/pack-context.js";
import { runSearch } from "../src/commands/search.js";
import { runStatus } from "../src/commands/status.js";
import { runServeMcp } from "../src/commands/serve.js";
import { runSync } from "../src/commands/sync.js";
import { runTrace } from "../src/commands/trace.js";
import { initWorkspace } from "../src/workspace/workspace.js";

describe("commands lifecycle", () => {
  let tempDir: string;
  let originalCwd: string;
  let savedXdg: string | undefined;
  let isolatedRegistry: string | undefined;

  afterEach(() => {
    process.chdir(originalCwd);
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
    if (savedXdg !== undefined) {
      process.env.XDG_CONFIG_HOME = savedXdg;
    } else if (isolatedRegistry) {
      delete process.env.XDG_CONFIG_HOME;
    }
    if (isolatedRegistry) {
      rmSync(isolatedRegistry, { recursive: true, force: true });
      isolatedRegistry = undefined;
    }
    savedXdg = undefined;
  });

  function useEmptyDir(): void {
    originalCwd = process.cwd();
    tempDir = mkdtempSync(join(tmpdir(), "argus-cmd-"));
    process.chdir(tempDir);
  }

  /** Isola o registry do daemon para que walk-up não ache workspaces reais. */
  function isolateRegistry(): void {
    savedXdg = process.env.XDG_CONFIG_HOME;
    isolatedRegistry = mkdtempSync(join(tmpdir(), "argus-empty-registry-"));
    process.env.XDG_CONFIG_HOME = isolatedRegistry;
  }

  it("index falha sem workspace com exit 1", async () => {
    useEmptyDir();
    isolateRegistry();
    await expect(runIndex()).resolves.toBe(1);
  });

  it("sync falha sem workspace com exit 1", async () => {
    useEmptyDir();
    isolateRegistry();
    await expect(runSync()).resolves.toBe(1);
  });

  it("serve --mcp falha sem workspace com exit 1", async () => {
    useEmptyDir();
    isolateRegistry();
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

  it("search retorna 1 sem workspace", () => {
    useEmptyDir();
    expect(runSearch("needle")).toBe(1);
  });

  it("files retorna 1 sem workspace", () => {
    useEmptyDir();
    expect(runFiles()).toBe(1);
  });

  it("explore retorna 1 sem workspace", () => {
    useEmptyDir();
    expect(runExplore("target")).toBe(1);
  });

  it("trace retorna 1 sem workspace", () => {
    useEmptyDir();
    expect(runTrace("target")).toBe(1);
  });

  it("impact retorna 1 sem workspace", () => {
    useEmptyDir();
    expect(runImpact("target")).toBe(1);
  });

  it("diff-impact retorna 1 sem workspace", () => {
    useEmptyDir();
    expect(runDiffImpact()).toBe(1);
  });

  it("pack-context retorna 1 sem workspace", async () => {
    useEmptyDir();
    await expect(runPackContext({ sources: ["app.ts"], goal: "debug", tokenBudget: 120 })).resolves.toBe(1);
  });
});
