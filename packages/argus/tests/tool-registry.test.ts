import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  ARGUS_MCP_TOOLS_ENV,
  DEFAULT_LISTED_MCP_TOOLS,
  MCP_SERVER_NAME,
  MCP_TOOL_NAMES,
  TOOL_DESCRIPTIONS,
  TOOL_INPUT_JSON_SCHEMAS,
  resolveListedTools,
} from "../src/mcp/tool-registry.js";
import { createMcpServer } from "../src/mcp/server.js";
import { buildToolResponse } from "../src/mcp/tools/response.js";
import { initWorkspace } from "../src/workspace/workspace.js";
import { runIndex } from "../src/commands/index-cmd.js";

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
    tempDir = mkdtempSync(join(tmpdir(), "argus-stub-"));
    process.chdir(tempDir);
    return tempDir;
  }

  it("registra as doze tools do runtime unificado", () => {
    expect(MCP_TOOL_NAMES).toHaveLength(12);
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
      "remember",
      "recall",
    ]);
  });

  it("default listed é o path feliz de cinco tools (inclui remember)", () => {
    expect(DEFAULT_LISTED_MCP_TOOLS).toEqual([
      "explore",
      "pack_context",
      "recall",
      "remember",
      "status",
    ]);
  });

  describe("resolveListedTools", () => {
    it("sem env retorna default slim", () => {
      const r = resolveListedTools(undefined, { emitDiagnostic: false });
      expect(r.mode).toBe("default");
      expect(r.listed).toEqual(DEFAULT_LISTED_MCP_TOOLS);
      expect(r.usedFallback).toBe(false);
    });

    it("all retorna as 12 registradas na ordem canônica", () => {
      const r = resolveListedTools("all", { emitDiagnostic: false });
      expect(r.mode).toBe("all");
      expect(r.listed).toEqual(MCP_TOOL_NAMES);
      expect(r.usedFallback).toBe(false);
    });

    it("CSV válido deduplica e preserva ordem estável", () => {
      const r = resolveListedTools("status,explore,status,recall", { emitDiagnostic: false });
      expect(r.mode).toBe("explicit");
      expect(r.listed).toEqual(["status", "explore", "recall"]);
      expect(r.usedFallback).toBe(false);
    });

    it("entrada inválida diagnostica e cai no default (não abre 12)", () => {
      const errors: string[] = [];
      const spy = vi.spyOn(console, "error").mockImplementation((m) => {
        errors.push(String(m));
      });
      const r = resolveListedTools("impact,nao_existe", { emitDiagnostic: true });
      spy.mockRestore();
      expect(r.mode).toBe("default");
      expect(r.listed).toEqual(DEFAULT_LISTED_MCP_TOOLS);
      expect(r.usedFallback).toBe(true);
      expect(r.warning).toMatch(/E_MCP_TOOLS_INVALID/);
      expect(errors.some((e) => e.includes("E_MCP_TOOLS_INVALID"))).toBe(true);
    });

    it("lista vazia cai no default com warning", () => {
      const r = resolveListedTools("   ", { emitDiagnostic: false });
      expect(r.usedFallback).toBe(true);
      expect(r.listed).toEqual(DEFAULT_LISTED_MCP_TOOLS);
      expect(r.warning).toMatch(/E_MCP_TOOLS_INVALID/);
    });
  });

  it("retrieve aceita handles de código e memória no JSON Schema", () => {
    expect(TOOL_INPUT_JSON_SCHEMAS.retrieve.properties.handle.pattern).toBe("^(rh|mh)_[a-f0-9]{16}$");
  });

  it("AC-3.2.1 retrieve.context_lines está no JSON Schema tipado", () => {
    const schema = TOOL_INPUT_JSON_SCHEMAS.retrieve;
    expect(schema.properties).toHaveProperty("context_lines");
    expect(schema.properties.context_lines).toMatchObject({
      type: "integer",
      minimum: 0,
      maximum: 100,
    });
    // additionalProperties false: capacidade descobrível só via properties tipadas.
    expect(schema.additionalProperties).toBe(false);
  });

  it("servidor MCP identificado como argus", () => {
    expect(MCP_SERVER_NAME).toBe("argus");
  });

  it("descrições do path feliz orientam intenção", () => {
    expect(TOOL_DESCRIPTIONS.explore).toMatch(/Path feliz|entendimento|refactor/i);
    expect(TOOL_DESCRIPTIONS.pack_context).toMatch(/budget|múltiplas|fontes/i);
    expect(TOOL_DESCRIPTIONS.recall).toMatch(/decisões|cofre/i);
    expect(TOOL_DESCRIPTIONS.remember).toMatch(/Path feliz|captura|cofre/i);
    expect(TOOL_DESCRIPTIONS.remember).not.toMatch(/unlisted/i);
    expect(TOOL_DESCRIPTIONS.status).toMatch(/slim|ARGUS_MCP_TOOLS=all/i);
  });

  it("cada stub declara state explícito parcial ou falha", () => {
    // Dir sem workspace: todos os tools caem no stub `falha` com código `E_*`,
    // que sobrevive ao concise (default). Sem isso o teste dependeria do cwd ter
    // ou não índice e do formato vigente — frágil e order-dependent.
    const dir = useEmptyDir();
    for (const tool of MCP_TOOL_NAMES) {
      const payload = buildToolResponse(tool, dir);
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

/**
 * S1 — prova ancorada: Client MCP real ↔ Server real via InMemoryTransport.
 * Não mocka registry/server; isola política via `listedToolsEnv` no boot.
 */
describe("S1 MCP surface slim (ListTools vs CallTool)", () => {
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

  function useIndexedWorkspace(): string {
    originalCwd = process.cwd();
    tempDir = mkdtempSync(join(tmpdir(), "argus-mcp-slim-"));
    writeFileSync(join(tempDir, "lib.ts"), "export function alpha() { return 1; }\n", "utf-8");
    initWorkspace(tempDir);
    process.chdir(tempDir);
    return tempDir;
  }

  async function connectClient(listedToolsEnv: string | undefined) {
    // Sempre passa listedToolsEnv: undefined = default slim (sem ler process.env do host).
    const server = createMcpServer({
      autoSync: false,
      listedToolsEnv,
    });
    const client = new Client({ name: "test-slim", version: "0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return client;
  }

  it("AC-2.1.1 ListTools sem env retorna exatamente as cinco default", async () => {
    useIndexedWorkspace();
    const client = await connectClient(undefined);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([...DEFAULT_LISTED_MCP_TOOLS]);
    expect(tools).toHaveLength(5);
    expect(tools.map((t) => t.name)).toContain("remember");
    expect(tools.map((t) => t.name)).not.toContain("retrieve");
    await client.close();
  });

  it("AC-1.1.2 ARGUS_MCP_TOOLS=all retorna as 12 registradas", async () => {
    useIndexedWorkspace();
    const client = await connectClient("all");
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([...MCP_TOOL_NAMES]);
    expect(tools).toHaveLength(12);
    await client.close();
  });

  it("AC-1.1.3 CSV válido filtra; inválido diagnostica e usa default", async () => {
    useIndexedWorkspace();
    const clientOk = await connectClient("recall,status");
    const listed = await clientOk.listTools();
    expect(listed.tools.map((t) => t.name)).toEqual(["recall", "status"]);
    await clientOk.close();

    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((m) => {
      errors.push(String(m));
    });
    const clientBad = await connectClient("bogus_tool");
    const fallback = await clientBad.listTools();
    spy.mockRestore();
    expect(fallback.tools.map((t) => t.name)).toEqual([...DEFAULT_LISTED_MCP_TOOLS]);
    expect(errors.some((e) => e.includes("E_MCP_TOOLS_INVALID"))).toBe(true);
    await clientBad.close();
  });

  it("AC-2.1.3 retrieve ausente do default e invocável via CallTool", async () => {
    const root = useIndexedWorkspace();
    expect(await runIndex()).toBe(0);
    const client = await connectClient(undefined);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).not.toContain("retrieve");

    // Pack gera handle; CallTool retrieve funciona mesmo unlisted.
    const packed = buildToolResponse("pack_context", root, {
      sources: ["lib.ts"],
      goal: "AC-2.1.3 retrieve unlisted",
      token_budget: 60,
      style: "deep",
      response_format: "detailed",
    });
    const handle = String(packed.retrieve_handle);
    expect(handle).toMatch(/^rh_[a-f0-9]{16}$/);

    const res = await client.callTool({
      name: "retrieve",
      arguments: { handle },
    });
    expect(res.isError).not.toBe(true);
    const text = (res.content as Array<{ type: string; text: string }>)[0].text;
    const payload = JSON.parse(text) as { state: string; content?: string };
    expect(["sucesso", "parcial"]).toContain(payload.state);
    expect(String(payload.content)).toContain("alpha");
    await client.close();
  });

  it("AC-1.2.1 CallTool de impact funciona quando impact não está em ListTools", async () => {
    useIndexedWorkspace();
    expect(await runIndex()).toBe(0);
    const client = await connectClient(undefined);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).not.toContain("impact");

    const res = await client.callTool({ name: "impact", arguments: { target: "alpha" } });
    expect(res.isError).not.toBe(true);
    const text = (res.content as Array<{ type: string; text: string }>)[0].text;
    const payload = JSON.parse(text) as { state: string; message?: string };
    expect(payload.state).not.toBe("falha");
    expect(payload.message ?? "").not.toMatch(/Tool desconhecida/);
    expect(text).toMatch(/direct_affected|risk_summary|alpha|parcial|sucesso/);
    await client.close();
  });

  it("AC-1.2.3 nenhuma chamada MCP escreve em stdout fora do protocolo", async () => {
    useIndexedWorkspace();
    const stdoutChunks: string[] = [];
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      stdoutChunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);

    const client = await connectClient(undefined);
    await client.listTools();
    await client.callTool({ name: "status", arguments: {} });
    await client.callTool({ name: "impact", arguments: { target: "alpha" } });
    await client.close();
    writeSpy.mockRestore();

    // InMemoryTransport não usa stdout; qualquer write espúrio de handlers é regressão.
    expect(stdoutChunks).toEqual([]);
  });

  it("AC-3.2.1 ListTools publica retrieve.context_lines quando override lista retrieve; CallTool aplica janela (S2)", async () => {
    const root = useIndexedWorkspace();
    expect(await runIndex()).toBe(0);

    // Override lista retrieve (unlisted por default) — schema público deve expor context_lines.
    const client = await connectClient("retrieve,status");
    const { tools } = await client.listTools();
    const retrieveTool = tools.find((t) => t.name === "retrieve");
    expect(retrieveTool).toBeTruthy();
    const props = (retrieveTool?.inputSchema as { properties?: Record<string, unknown> })?.properties;
    expect(props).toHaveProperty("context_lines");

    // Pack com budget baixo gera handle; retrieve com context_lines expande do disco real.
    const packed = buildToolResponse("pack_context", root, {
      sources: ["lib.ts"],
      goal: "S2 context_lines",
      token_budget: 60,
      style: "deep",
      response_format: "detailed",
    });
    const handle = String(packed.retrieve_handle);
    expect(handle).toMatch(/^rh_[a-f0-9]{16}$/);

    const res = await client.callTool({
      name: "retrieve",
      arguments: { handle, context_lines: 1 },
    });
    expect(res.isError).not.toBe(true);
    const text = (res.content as Array<{ type: string; text: string }>)[0].text;
    const payload = JSON.parse(text) as {
      state: string;
      context_lines?: number;
      content?: string;
    };
    expect(["sucesso", "parcial"]).toContain(payload.state);
    expect(payload.context_lines).toBe(1);
    expect(String(payload.content)).toContain("alpha");
    await client.close();
  });

  it("env var name documentada bate com constante", () => {
    expect(ARGUS_MCP_TOOLS_ENV).toBe("ARGUS_MCP_TOOLS");
  });
});
