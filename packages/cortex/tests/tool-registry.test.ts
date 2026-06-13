import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MCP_SERVER_NAME, MCP_TOOL_NAMES } from "../src/mcp/tool-registry.js";
import { buildToolStub } from "../src/mcp/tools/stubs.js";
import { initWorkspace } from "../src/workspace/workspace.js";

describe("tool-registry", () => {
  let tempDir: string | undefined;
  let originalCwd: string | undefined;

  afterEach(() => {
    if (originalCwd) {
      process.chdir(originalCwd);
    }
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
    originalCwd = undefined;
  });

  function useEmptyDir(): string {
    originalCwd = process.cwd();
    tempDir = mkdtempSync(join(tmpdir(), "cortex-stub-"));
    process.chdir(tempDir);
    return tempDir;
  }

  it("registra exatamente oito tools congeladas", () => {
    expect(MCP_TOOL_NAMES).toHaveLength(8);
    expect(MCP_TOOL_NAMES).toEqual([
      "search",
      "explore",
      "trace",
      "impact",
      "diff_impact",
      "files",
      "pack_context",
      "status",
    ]);
  });

  it("servidor MCP identificado como atlas-cortex", () => {
    expect(MCP_SERVER_NAME).toBe("atlas-cortex");
  });

  it("cada stub declara state explícito parcial ou falha", () => {
    for (const tool of MCP_TOOL_NAMES) {
      const payload = buildToolStub(tool);
      expect(["parcial", "falha"]).toContain(payload.state);
      expect(payload.message).toBeTruthy();
    }
  });

  it("stubs parciais incluem limitations[]", () => {
    for (const tool of MCP_TOOL_NAMES) {
      const payload = buildToolStub(tool);
      if (payload.state === "parcial") {
        expect(payload.limitations?.length).toBeGreaterThan(0);
      }
    }
  });

  it("status sem workspace retorna falha e initialized false", () => {
    const dir = useEmptyDir();
    const payload = buildToolStub("status", dir);
    expect(payload.initialized).toBe(false);
    expect(payload.state).toBe("falha");
    expect(payload.message).toMatch(/E_WORKSPACE_INVALID/);
  });

  it("status com workspace preparado alinha shape SURFACE §8", () => {
    const dir = useEmptyDir();
    initWorkspace(dir);
    const payload = buildToolStub("status", dir);
    expect(payload.initialized).toBe(true);
    expect(payload.staleness).toBe("unknown");
    expect(payload.pending_files_count).toBe(0);
    expect(payload.coverage_by_language).toEqual({});
    expect(payload.state).toBe("parcial");
    expect(payload.staleness_hint).toBeTruthy();
  });

  it("tools de retrieval falham sem workspace", () => {
    const dir = useEmptyDir();
    const payload = buildToolStub("search", dir);
    expect(payload.state).toBe("falha");
    expect(payload.message).toMatch(/E_WORKSPACE_INVALID/);
  });

  it("impact e diff_impact usam campos SURFACE §4–5", () => {
    const dir = useEmptyDir();
    initWorkspace(dir);
    const impact = buildToolStub("impact", dir);
    expect(impact).toMatchObject({
      direct_affected: [],
      indirect_affected: [],
      files: [],
      tests: [],
      risk_summary: "",
    });

    const diff = buildToolStub("diff_impact", dir);
    expect(diff).toMatchObject({
      changed_files: [],
      changed_symbols: [],
      affected_areas: [],
      affected_tests: [],
      risk_summary: "",
    });
  });

  it("pack_context stub expõe campos de packing SURFACE §7", () => {
    const dir = useEmptyDir();
    initWorkspace(dir);
    const payload = buildToolStub("pack_context", dir, {
      sources: ["foo.ts"],
      goal: "entender",
      token_budget: 120,
    });
    expect(payload).toMatchObject({
      packed_context: "",
      origin_refs: [],
      removed_or_summarized: [],
      reversibility: "none",
    });
  });
});
