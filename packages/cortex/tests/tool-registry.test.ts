import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MCP_SERVER_NAME, MCP_TOOL_NAMES } from "../src/mcp/tool-registry.js";
import { buildToolResponse } from "../src/mcp/tools/response.js";
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

  it("registra as dez tools do runtime maduro", () => {
    expect(MCP_TOOL_NAMES).toHaveLength(10);
    expect(MCP_TOOL_NAMES).toEqual([
      "search",
      "explore",
      "trace",
      "impact",
      "diff_impact",
      "files",
      "pack_context",
      "retrieve",
      "status",
      "semantic_search",
    ]);
  });

  it("servidor MCP identificado como atlas-cortex", () => {
    expect(MCP_SERVER_NAME).toBe("atlas-cortex");
  });

  it("cada stub declara state explícito parcial ou falha", () => {
    for (const tool of MCP_TOOL_NAMES) {
      const payload = buildToolResponse(tool);
      expect(["parcial", "falha"]).toContain(payload.state);
      expect(payload.message).toBeTruthy();
    }
  });

  it("stubs parciais (detailed) incluem limitations[]", () => {
    const dir = useEmptyDir();
    initWorkspace(dir);
    for (const tool of MCP_TOOL_NAMES) {
      const payload = buildToolResponse(tool, dir, { response_format: "detailed" });
      if (payload.state === "parcial") {
        expect(payload.limitations?.length).toBeGreaterThan(0);
      }
    }
  });

  it("modo concise dropa limitations e staleness_hint", () => {
    const dir = useEmptyDir();
    initWorkspace(dir);
    for (const tool of MCP_TOOL_NAMES) {
      const payload = buildToolResponse(tool, dir);
      expect(payload.limitations).toBeUndefined();
      expect(payload.staleness_hint).toBeUndefined();
      expect(payload.confidence).toBeUndefined();
    }
  });

  it("status sem workspace retorna falha e initialized false", () => {
    const dir = useEmptyDir();
    const payload = buildToolResponse("status", dir);
    expect(payload.initialized).toBe(false);
    expect(payload.state).toBe("falha");
    expect(payload.message).toMatch(/E_WORKSPACE_INVALID/);
  });

  it("status com workspace preparado alinha shape SURFACE §8", () => {
    const dir = useEmptyDir();
    initWorkspace(dir);
    const payload = buildToolResponse("status", dir, { response_format: "detailed" });
    expect(payload.initialized).toBe(true);
    expect(payload.staleness).toBe("unknown");
    expect(payload.pending_files_count).toBe(0);
    expect(payload.coverage_by_language).toEqual({});
    expect(payload.state).toBe("parcial");
    expect(payload.staleness_hint).toBeTruthy();
  });

  it("tools de retrieval falham sem workspace", () => {
    const dir = useEmptyDir();
    const payload = buildToolResponse("search", dir);
    expect(payload.state).toBe("falha");
    expect(payload.message).toMatch(/E_WORKSPACE_INVALID/);
  });

  it("impact e diff_impact usam campos SURFACE §4–5", () => {
    const dir = useEmptyDir();
    initWorkspace(dir);
    const impact = buildToolResponse("impact", dir, { response_format: "detailed" });
    expect(impact).toMatchObject({
      direct_affected: [],
      indirect_affected: [],
      files: [],
      tests: [],
      risk_summary: "",
    });

    const diff = buildToolResponse("diff_impact", dir);
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
    const payload = buildToolResponse("pack_context", dir, {
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
