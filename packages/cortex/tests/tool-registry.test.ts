import { describe, expect, it } from "vitest";
import { MCP_SERVER_NAME, MCP_TOOL_NAMES } from "../src/mcp/tool-registry.js";
import { buildToolStub } from "../src/mcp/tools/stubs.js";

describe("tool-registry", () => {
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

  it("status stub retorna shape mínimo PLAN §6.2", () => {
    const payload = buildToolStub("status");
    expect(payload.ready).toBe(false);
    expect(payload.stale).toBe(true);
    expect(payload.pending).toContain("index");
    expect(payload.state).toBe("parcial");
  });
});
