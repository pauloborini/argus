import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp/server.js";
import {
  DEFAULT_MCP_RESPONSE_BUDGET,
  enforceResponseBudget,
} from "../src/mcp/tools/response.js";
import type { ToolResponsePayload } from "../src/mcp/tools/common.js";
import { countTokens } from "../src/packing/tokenizer.js";
import { initWorkspace } from "../src/workspace/workspace.js";
import { runIndex } from "../src/commands/index-cmd.js";

describe("MCP-CONTRACT-001 — response budget and strict args", () => {
  let tempDir: string | undefined;
  let originalCwd: string | undefined;
  const originalEnvBudget = process.env.ARGUS_MCP_RESPONSE_BUDGET;

  beforeEach(() => {
    delete process.env.ARGUS_MCP_RESPONSE_BUDGET;
  });

  afterEach(() => {
    if (originalEnvBudget !== undefined) {
      process.env.ARGUS_MCP_RESPONSE_BUDGET = originalEnvBudget;
    } else {
      delete process.env.ARGUS_MCP_RESPONSE_BUDGET;
    }
    if (originalCwd) {
      process.chdir(originalCwd);
      originalCwd = undefined;
    }
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  function setupWorkspaceWithFiles(fileCount = 30): string {
    originalCwd = process.cwd();
    tempDir = mkdtempSync(join(tmpdir(), "argus-budget-test-"));
    process.chdir(tempDir);
    initWorkspace(tempDir);
    for (let i = 0; i < fileCount; i++) {
      writeFileSync(
        join(tempDir, `file_${i.toString().padStart(3, "0")}.ts`),
        `export function func_${i}() { return "large string payload to generate tokens in exploration and file responses ${i}"; }\n`,
        "utf-8",
      );
    }
    return tempDir;
  }

  async function connectClient() {
    const server = createMcpServer({ autoSync: false });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(clientTransport);
    return { client, server };
  }

  it("§7.1 — resposta JSON acima do budget sai <= budget, JSON válido, W_RESPONSE_TRUNCATED e state parcial", async () => {
    // Monta payload sintético > budget (20000 tokens)
    const largeCandidates = Array.from({ length: 600 }, (_, i) => ({
      name: `symbol_${i}`,
      path: `src/deep/nested/path/component_${i}.ts`,
      kind: "function",
      snippet: `export function symbol_${i}() {\n  // Repetitive code snippet to consume substantial token budget\n  const val = ${i} * 42;\n  return val;\n}`,
    }));

    const syntheticPayload: ToolResponsePayload = {
      state: "sucesso",
      candidates: largeCandidates,
      limitations: [],
    };

    const initialTokens = countTokens(JSON.stringify(syntheticPayload));
    expect(initialTokens).toBeGreaterThan(DEFAULT_MCP_RESPONSE_BUDGET);

    const truncated = enforceResponseBudget(syntheticPayload);
    const jsonText = JSON.stringify(truncated);
    const parsed = JSON.parse(jsonText);

    expect(countTokens(jsonText)).toBeLessThanOrEqual(DEFAULT_MCP_RESPONSE_BUDGET);
    expect(parsed.state).toBe("parcial");
    expect(parsed.limitations).toContain("W_RESPONSE_TRUNCATED");
  });

  it("§7.1 — integração CallTool: dispatch trunca resposta quando budget é excedido", async () => {
    setupWorkspaceWithFiles(40);
    await runIndex();

    // Reduz budget para 50 tokens via env
    process.env.ARGUS_MCP_RESPONSE_BUDGET = "50";

    const { client } = await connectClient();
    const res = await client.callTool({
      name: "files",
      arguments: {},
    });

    expect(res.isError).toBeFalsy();
    const text = (res.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text);

    expect(countTokens(text)).toBeLessThanOrEqual(50);
    expect(parsed.state).toBe("parcial");
    expect(parsed.limitations).toContain("W_RESPONSE_TRUNCATED");

    await client.close();
  });

  it("§7.2 — ARGUS_MCP_RESPONSE_BUDGET=1000 reduz o teto aplicado", () => {
    // Monta payload sintético entre 1000 e 20000 tokens (~2500 tokens)
    const items = Array.from({ length: 70 }, (_, i) => ({
      id: `item_${i}`,
      name: `FunctionComponentItem${i}`,
      description: `Detailed description for component item ${i} to reach moderate token count`,
      content: `const handler${i} = () => { console.log('item ${i}'); };`,
    }));

    const payload: ToolResponsePayload = {
      state: "sucesso",
      results: items,
      limitations: [],
    };

    const initialTokens = countTokens(JSON.stringify(payload));
    expect(initialTokens).toBeGreaterThan(1000);
    expect(initialTokens).toBeLessThan(DEFAULT_MCP_RESPONSE_BUDGET);

    // Sem a env: passa inteiro
    delete process.env.ARGUS_MCP_RESPONSE_BUDGET;
    const full = enforceResponseBudget(payload);
    expect(countTokens(JSON.stringify(full))).toBe(initialTokens);
    expect(full.state).toBe("sucesso");
    expect(full.limitations ?? []).not.toContain("W_RESPONSE_TRUNCATED");

    // Com a env = 1000: truncado
    process.env.ARGUS_MCP_RESPONSE_BUDGET = "1000";
    const truncated = enforceResponseBudget(payload);
    const jsonText = JSON.stringify(truncated);
    expect(countTokens(jsonText)).toBeLessThanOrEqual(1000);
    expect(truncated.state).toBe("parcial");
    expect(truncated.limitations).toContain("W_RESPONSE_TRUNCATED");
  });

  it("§7.3 — CallTool com chave desconhecida retorna falha citando a chave; sem chave extra tem sucesso", async () => {
    setupWorkspaceWithFiles(5);
    await runIndex();

    const { client } = await connectClient();

    // 1. Chave desconhecida (queryy em vez de query)
    const failRes = await client.callTool({
      name: "search",
      arguments: { query: "func", queryy: "extra" },
    });

    expect(failRes.isError).toBe(true);
    const failText = (failRes.content as Array<{ type: string; text: string }>)[0].text;
    const failPayload = JSON.parse(failText);
    expect(failPayload.state).toBe("falha");
    expect(failPayload.message).toContain("queryy");
    expect(failPayload.message).toContain("query"); // sugestão da chave mais próxima

    // 2. Mesma chamada sem a chave extra
    const okRes = await client.callTool({
      name: "search",
      arguments: { query: "func" },
    });

    expect(okRes.isError).toBeFalsy();
    const okText = (okRes.content as Array<{ type: string; text: string }>)[0].text;
    const okPayload = JSON.parse(okText);
    expect(okPayload.state).not.toBe("falha");

    await client.close();
  });
});
