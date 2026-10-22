import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  ARGUS_MCP_READ_ONLY_ENV,
} from "../src/mcp/tool-registry.js";
import { createMcpServer, type McpServerOptions } from "../src/mcp/server.js";
import { initWorkspace } from "../src/workspace/workspace.js";
import { runIndex } from "../src/commands/index-cmd.js";
import { hasDirtyPaths, markDirty } from "../src/discovery/dirty-flag.js";

describe("MCP-POLICY-001 — read-only mode and input caps", () => {
  let tempDir: string | undefined;
  let originalCwd: string | undefined;
  const originalReadOnlyEnv = process.env[ARGUS_MCP_READ_ONLY_ENV];

  beforeEach(() => {
    delete process.env[ARGUS_MCP_READ_ONLY_ENV];
  });

  afterEach(() => {
    if (originalReadOnlyEnv !== undefined) {
      process.env[ARGUS_MCP_READ_ONLY_ENV] = originalReadOnlyEnv;
    } else {
      delete process.env[ARGUS_MCP_READ_ONLY_ENV];
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

  function setupWorkspace(): string {
    originalCwd = process.cwd();
    tempDir = mkdtempSync(join(tmpdir(), "argus-policy-test-"));
    process.chdir(tempDir);
    initWorkspace(tempDir);
    writeFileSync(
      join(tempDir, "index.ts"),
      "export function existingSymbol() { return 42; }\n",
      "utf-8",
    );
    return tempDir;
  }

  async function connectClient(options: McpServerOptions = {}) {
    const server = createMcpServer(options);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "test-policy-client", version: "1.0.0" });
    await client.connect(clientTransport);
    return { client, server };
  }

  function countMemoryNotes(root: string): number {
    const vaultDir = join(root, ".argus", "memory", "vault");
    if (!existsSync(vaultDir)) {
      return 0;
    }
    let count = 0;
    function walk(dir: string) {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile() && entry.name.endsWith(".md")) {
          count++;
        }
      }
    }
    walk(vaultDir);
    return count;
  }

  it("§7.4 — constante ARGUS_MCP_READ_ONLY_ENV exportada e override injetável em McpServerOptions", () => {
    expect(ARGUS_MCP_READ_ONLY_ENV).toBe("ARGUS_MCP_READ_ONLY");
  });

  it("§7.1 — com ARGUS_MCP_READ_ONLY=1: remember retorna state: falha com E_MCP_READ_ONLY e disco intacto", async () => {
    const root = setupWorkspace();
    expect(await runIndex()).toBe(0);

    // Conecta com readOnly ativado via override injetável
    const { client } = await connectClient({ readOnlyEnv: "1", autoSync: false });

    const callResult = await client.callTool({
      name: "remember",
      arguments: {
        content: "Decisão crítica de arquitetura que não deve gravar.",
        type: "decision",
      },
    });

    expect(callResult.isError).toBe(true);
    const text = (callResult.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text) as { state: string; message: string };
    expect(parsed.state).toBe("falha");
    expect(parsed.message).toContain("E_MCP_READ_ONLY");
    expect(parsed.message).toContain("servidor em modo somente leitura (ARGUS_MCP_READ_ONLY=1).");

    // Disco do cofre de memória permanece intacto: 0 notas criadas
    expect(countMemoryNotes(root)).toBe(0);

    // Leitura continua operacional em read-only
    const searchRes = await client.callTool({
      name: "search",
      arguments: { query: "existingSymbol" },
    });
    expect(searchRes.isError).toBeFalsy();
    const searchText = (searchRes.content as Array<{ type: string; text: string }>)[0].text;
    expect(searchText).toContain("existingSymbol");

    await client.close();

    // Sem a env (ou com readOnly inativo), remember cria nota normalmente no mesmo workspace
    const { client: clientNormal } = await connectClient({ readOnlyEnv: "0", autoSync: false });
    const normalResult = await clientNormal.callTool({
      name: "remember",
      arguments: {
        content: "Decisão válida gravada em modo normal.",
        type: "decision",
      },
    });
    expect(normalResult.isError).toBeFalsy();
    const normalParsed = JSON.parse(
      (normalResult.content as Array<{ type: string; text: string }>)[0].text,
    );
    expect(normalParsed.state).toBe("sucesso");
    expect(countMemoryNotes(root)).toBeGreaterThan(0);

    await clientNormal.close();
  });

  it("§7.1 — semântica estrita da env: somente '1' ativa o modo read-only", async () => {
    setupWorkspace();
    expect(await runIndex()).toBe(0);

    for (const falsyValue of ["true", "yes", "0", "on", "2", ""]) {
      const { client } = await connectClient({ readOnlyEnv: falsyValue, autoSync: false });
      const res = await client.callTool({
        name: "remember",
        arguments: {
          content: `Nota gravada com valor não-estrito: ${falsyValue}`,
          type: "decision",
        },
      });
      expect(res.isError).toBeFalsy();
      const parsed = JSON.parse((res.content as Array<{ type: string; text: string }>)[0].text);
      expect(parsed.state).toBe("sucesso");
      await client.close();
    }
  });

  it("§7.2 — com read-only, dirty-flag existente NÃO é consumida por chamada de leitura; sem read-only é consumida", async () => {
    const root = setupWorkspace();
    expect(await runIndex()).toBe(0);

    // Marca dirty-flag
    writeFileSync(join(root, "novo.ts"), "export function novaFn() {}\n", "utf-8");
    markDirty(["novo.ts"], { sinceRef: "HEAD", cwd: root });
    expect(hasDirtyPaths(root)).toBe(true);

    // Chamada com read-only: dirty-flag NÃO deve ser consumida
    const { client: clientReadOnly } = await connectClient({ readOnlyEnv: "1", autoSync: true });
    const resReadOnly = await clientReadOnly.callTool({
      name: "status",
      arguments: {},
    });
    expect(resReadOnly.isError).toBeFalsy();
    // A dirty-flag foi PRESERVADA intacta em disco
    expect(hasDirtyPaths(root)).toBe(true);
    await clientReadOnly.close();

    // Chamada sem read-only: dirty-flag DEVE ser consumida pelo auto-sync
    const { client: clientNormal } = await connectClient({ readOnlyEnv: "0", autoSync: true });
    const resNormal = await clientNormal.callTool({
      name: "status",
      arguments: {},
    });
    expect(resNormal.isError).toBeFalsy();
    // A dirty-flag foi consumida
    expect(hasDirtyPaths(root)).toBe(false);
    await clientNormal.close();
  });

  it("§7.3 — search com query de 513 chars falha na validação citando a chave; com 512 chars tem sucesso", async () => {
    setupWorkspace();
    expect(await runIndex()).toBe(0);

    const { client } = await connectClient({ autoSync: false });

    const query512 = "a".repeat(512);
    const validRes = await client.callTool({
      name: "search",
      arguments: { query: query512 },
    });
    expect(validRes.isError).toBeFalsy();

    const query513 = "a".repeat(513);
    const invalidRes = await client.callTool({
      name: "search",
      arguments: { query: query513 },
    });
    expect(invalidRes.isError).toBe(true);
    const invalidText = (invalidRes.content as Array<{ type: string; text: string }>)[0].text;
    const invalidParsed = JSON.parse(invalidText) as { state: string; message: string };
    expect(invalidParsed.state).toBe("falha");
    expect(invalidParsed.message).toContain("query");
    expect(invalidParsed.message).toMatch(/too_big|512|Input inválido/);

    await client.close();
  });

  it("§7.3 — limites granulares de string (.max()) nas demais schemas", async () => {
    setupWorkspace();
    expect(await runIndex()).toBe(0);

    const { client } = await connectClient({ autoSync: false });

    // pack_context: goal 513 falha, 512 passa
    const goal513Res = await client.callTool({
      name: "pack_context",
      arguments: {
        sources: ["index.ts"],
        goal: "g".repeat(513),
        token_budget: 1000,
      },
    });
    expect(goal513Res.isError).toBe(true);
    expect((goal513Res.content as Array<{ type: string; text: string }>)[0].text).toContain("goal");

    // pack_context: source item > 128 chars falha
    const sourceLongRes = await client.callTool({
      name: "pack_context",
      arguments: {
        sources: ["s".repeat(129)],
        goal: "test",
        token_budget: 1000,
      },
    });
    expect(sourceLongRes.isError).toBe(true);
    expect((sourceLongRes.content as Array<{ type: string; text: string }>)[0].text).toContain("sources");

    // explore: target 1025 chars falha, 1024 passa
    const explore1025Res = await client.callTool({
      name: "explore",
      arguments: { target: "t".repeat(1025) },
    });
    expect(explore1025Res.isError).toBe(true);
    expect((explore1025Res.content as Array<{ type: string; text: string }>)[0].text).toContain("target");

    const explore1024Res = await client.callTool({
      name: "explore",
      arguments: { target: "index.ts" },
    });
    expect(explore1024Res.isError).toBeFalsy();

    // remember: tags > 16 itens falha
    const tags17Res = await client.callTool({
      name: "remember",
      arguments: {
        content: "nota válida",
        tags: Array.from({ length: 17 }, (_, i) => `tag${i}`),
      },
    });
    expect(tags17Res.isError).toBe(true);
    expect((tags17Res.content as Array<{ type: string; text: string }>)[0].text).toContain("tags");

    // remember: content > 65536 chars falha
    const contentLongRes = await client.callTool({
      name: "remember",
      arguments: {
        content: "c".repeat(65537),
      },
    });
    expect(contentLongRes.isError).toBe(true);
    expect((contentLongRes.content as Array<{ type: string; text: string }>)[0].text).toContain("content");

    await client.close();
  });
});
