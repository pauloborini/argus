/**
 * S8v2 — jornada MCP (ListTools slim → explore [→retrieve se truncado] → remember→recall → status).
 * Seam real: Client + Server via InMemoryTransport; sem mock do registry/server/loaders.
 *
 * Nível de prova (INV-H6 / D8): protocolo + jornada MCP in-process com fixture stress
 * (truncate→retrieve). Não mede churn de agente LLM (Read/Grep) — claim honestamente
 * "MCP journey", não "agent-facing LLM churn".
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { installAgentRules, AGENT_RULES_VERSION } from "../../src/commands/agent-rules.js";
import { runIndex } from "../../src/commands/index-cmd.js";
import { createMcpServer } from "../../src/mcp/server.js";
import { DEFAULT_LISTED_MCP_TOOLS } from "../../src/mcp/tool-registry.js";
import { VaultEngine } from "../../src/memory/vault-engine.js";
import {
  getFullStructuralLoadCount,
  resetFullStructuralLoadCount,
} from "../../src/storage/index-persistence.js";
import { ARGUS_VERSION } from "../../src/version.js";
import { initWorkspace } from "../../src/workspace/workspace.js";

const HERE = dirname(fileURLToPath(import.meta.url));
export const HOMOLOGATION_FIXTURES_ROOT = join(HERE, "../fixtures/homologation");
export const HOMOLOGATE_AGENT_GOLDEN_PATH = join(
  HERE,
  "../fixtures/goldens/homologate-agent-v2.json",
);

/** Legacy path kept for reference; S8v2 golden is v2. */
export const HOMOLOGATE_AGENT_V1_GOLDEN_PATH = join(
  HERE,
  "../fixtures/goldens/homologate-agent-v1.json",
);

export interface CorpusSpec {
  id: string;
  size: "small" | "medium" | "stress";
  dirName: string;
  probeTarget: string;
  probeNeedle: string;
  /** Quando true, a jornada exige truncamento + retrieve com needle no corpo expandido. */
  expectTruncate: boolean;
}

export const HOMOLOGATION_CORPORA: readonly CorpusSpec[] = [
  {
    id: "corpus-small",
    size: "small",
    dirName: "corpus-small",
    probeTarget: "calculateTotal",
    probeNeedle: "helper()",
    expectTruncate: false,
  },
  {
    id: "corpus-medium",
    size: "medium",
    dirName: "corpus-medium",
    probeTarget: "placeOrder",
    probeNeedle: "calculateInvoice",
    expectTruncate: false,
  },
  {
    id: "corpus-stress",
    size: "stress",
    dirName: "corpus-stress",
    probeTarget: "largeHardeningSymbol",
    probeNeedle: "HARDENING_NEEDLE_BEYOND_CAP_16",
    expectTruncate: true,
  },
] as const;

export interface CorpusJourneyResult {
  corpus_id: string;
  size: string;
  listed_tools: string[];
  listed_count: number;
  tool_sequence: string[];
  explore: {
    state: string;
    truncated: boolean;
    actionable: boolean;
    snippet_body: string;
    has_retrieve_handle: boolean;
    retrieved: boolean;
    retrieved_body: string;
    needle_in_snippet: boolean;
    needle_in_retrieve: boolean;
  };
  remember_recall: {
    remember_state: string;
    recall_hit: boolean;
    unique_token: string;
    sync_called: boolean;
  };
  status: {
    state: string;
    initialized: boolean;
    mcp_slim: boolean;
    listed_tools: string[];
  };
  agent_rules: {
    version: number | null;
    has_happy_path: boolean;
  };
  full_structural_load_count: number;
  stdout_write_count: number;
}

export interface AgentHomologationCapture {
  provenance: {
    id: string;
    captured: string;
    command: string;
    runtime_version: string;
    seam: string;
    level: string;
    corpora: Array<{ id: string; size: string; path: string }>;
    notes: string;
  };
  corpora: Record<
    string,
    {
      listed_tools: string[];
      listed_count: number;
      tool_sequence: string[];
      explore_state: string;
      explore_truncated: boolean;
      explore_actionable: boolean;
      explore_snippet_body: string;
      retrieve_used: boolean;
      needle_in_snippet: boolean;
      needle_in_retrieve: boolean;
      remember_state: string;
      recall_hit: boolean;
      sync_called: boolean;
      status_initialized: boolean;
      status_mcp_slim: boolean;
      agent_rules_version: number | null;
      full_structural_load_count: number;
      stdout_write_count: number;
    }
  >;
}

function parseToolJson(result: {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}): Record<string, unknown> {
  const text = result.content?.find((c) => c.type === "text")?.text;
  if (!text) {
    throw new Error("Resposta MCP sem content text");
  }
  return JSON.parse(text) as Record<string, unknown>;
}

function materializeCorpus(spec: CorpusSpec): { root: string; cleanup: () => void } {
  const temp = mkdtempSync(join(tmpdir(), `argus-s8v2-${spec.id}-`));
  const source = join(HOMOLOGATION_FIXTURES_ROOT, spec.dirName);
  cpSync(source, temp, { recursive: true });
  initWorkspace(temp);
  VaultEngine.init(temp);
  installAgentRules(temp);
  return {
    root: temp,
    cleanup: () => rmSync(temp, { recursive: true, force: true }),
  };
}

/**
 * Executa a jornada completa em um corpus (MCP real in-process).
 * AC-6.1.1: se explore truncar, retrieve é obrigatório.
 * AC-6.1.2: needle pós-retrieve ⊆ corpo expandido (não basta assinatura).
 * AC-6.1.3: ListTools inclui remember; remember→recall sem sync.
 */
export async function runCorpusAgentJourney(spec: CorpusSpec): Promise<CorpusJourneyResult> {
  const { root, cleanup } = materializeCorpus(spec);
  const originalCwd = process.cwd();
  process.chdir(root);

  const stdoutWrites: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  const spyWrite: typeof process.stdout.write = ((chunk: unknown, ...args: unknown[]) => {
    stdoutWrites.push(String(chunk));
    // @ts-expect-error — encaminha assinatura overload do Node
    return originalWrite(chunk, ...args);
  }) as typeof process.stdout.write;

  try {
    const indexCode = await runIndex();
    if (indexCode !== 0) {
      throw new Error(`runIndex falhou com exit ${indexCode}`);
    }

    resetFullStructuralLoadCount();
    process.stdout.write = spyWrite;

    const server = createMcpServer({ autoSync: false });
    const client = new Client({ name: "homologate-agent-s8v2", version: ARGUS_VERSION });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const toolSequence: string[] = [];
    // AC-6.1.3: prova real de "sem sync" — spy em VaultEngine.sync (não só ausência na sequência).
    let vaultSyncCalls = 0;
    const originalVaultSync = VaultEngine.sync;
    VaultEngine.sync = ((...args: Parameters<typeof VaultEngine.sync>) => {
      vaultSyncCalls += 1;
      return originalVaultSync.apply(VaultEngine, args);
    }) as typeof VaultEngine.sync;

    try {
      const listed = await client.listTools();
      const listedNames = listed.tools.map((t) => t.name);

      const exploreRes = await client.callTool({
        name: "explore",
        arguments: { target: spec.probeTarget, mode: "symbol" },
      });
      toolSequence.push("explore");
      const explorePayload = parseToolJson(exploreRes);
      const snippets =
        (explorePayload.snippets as Array<{
          body?: string;
          signature?: string;
          truncated?: boolean;
        }>) ?? [];
      const snippetBody = snippets.map((s) => s.body ?? "").join("\n");
      const signature = snippets.map((s) => s.signature ?? "").join("\n");
      const truncated =
        snippets.some((s) => s.truncated === true) ||
        typeof explorePayload.retrieve_handle === "string";
      const needleInSnippet = snippetBody.includes(spec.probeNeedle);
      const handle =
        typeof explorePayload.retrieve_handle === "string"
          ? explorePayload.retrieve_handle
          : undefined;

      let retrieved = false;
      let retrievedBody = "";
      let needleInRetrieve = false;

      // AC-6.1.1: truncado exige retrieve (handle presente → CallTool retrieve).
      if (truncated || handle) {
        if (!handle) {
          throw new Error(
            `AC-6.1.1: explore truncado em ${spec.id} sem retrieve_handle — jornada inválida`,
          );
        }
        const retrieveRes = await client.callTool({
          name: "retrieve",
          arguments: { handle, context_lines: 3 },
        });
        toolSequence.push("retrieve");
        retrieved = true;
        const retrievePayload = parseToolJson(retrieveRes);
        retrievedBody = String(retrievePayload.content ?? "");
        needleInRetrieve = retrievedBody.includes(spec.probeNeedle);
        // AC-6.1.2: needle no corpo expandido, não só assinatura do explore.
        if (!needleInRetrieve) {
          throw new Error(
            `AC-6.1.2: needle "${spec.probeNeedle}" ausente do corpo retrieve em ${spec.id}`,
          );
        }
      }

      // Needle acionável: snippet verbatim OU corpo retrieve (stress).
      const actionable = needleInSnippet || needleInRetrieve;

      const unique = `s8v2-homolog-${spec.id}-${Date.now()}`;
      const rememberRes = await client.callTool({
        name: "remember",
        arguments: {
          content: `Decisão homologação MCP journey ${unique}`,
          type: "decision",
        },
      });
      toolSequence.push("remember");
      const rememberPayload = parseToolJson(rememberRes);

      // AC-6.1.3: recall same-session sem sync (VaultEngine.sync / tool sync).
      const recallRes = await client.callTool({
        name: "recall",
        arguments: { query: unique, limit: 5 },
      });
      toolSequence.push("recall");
      const recallPayload = parseToolJson(recallRes);
      const chunks =
        (recallPayload.chunks as Array<{ snippet?: string; content?: string }>) ?? [];
      const recallHit = chunks.some(
        (c) => (c.snippet ?? "").includes(unique) || (c.content ?? "").includes(unique),
      );

      const statusRes = await client.callTool({ name: "status", arguments: {} });
      toolSequence.push("status");
      const statusPayload = parseToolJson(statusRes);
      const mcpSurface = (statusPayload.mcp_surface as {
        slim?: boolean;
        listed_tools?: string[];
      }) ?? {};

      await client.close();

      const syncInSequence = toolSequence.some((t) => t === "sync" || t.includes("sync"));
      const syncCalled = vaultSyncCalls > 0 || syncInSequence;

      const agentsMd = readFileSync(join(root, "AGENTS.md"), "utf-8");
      const versionMatch = agentsMd.match(/argus-agent-rules-version:\s*(\d+)/);
      const hasHappyPath = DEFAULT_LISTED_MCP_TOOLS.every((name) => agentsMd.includes(name));

      return {
        corpus_id: spec.id,
        size: spec.size,
        listed_tools: listedNames,
        listed_count: listedNames.length,
        tool_sequence: toolSequence,
        explore: {
          state: String(explorePayload.state),
          truncated,
          actionable,
          snippet_body: snippetBody || signature,
          has_retrieve_handle: Boolean(handle),
          retrieved,
          retrieved_body: retrievedBody,
          needle_in_snippet: needleInSnippet,
          needle_in_retrieve: needleInRetrieve,
        },
        remember_recall: {
          remember_state: String(rememberPayload.state),
          recall_hit: recallHit,
          unique_token: unique,
          sync_called: syncCalled,
        },
        status: {
          state: String(statusPayload.state),
          initialized: statusPayload.initialized === true,
          mcp_slim: mcpSurface.slim === true,
          listed_tools: mcpSurface.listed_tools ?? listedNames,
        },
        agent_rules: {
          version: versionMatch ? Number(versionMatch[1]) : null,
          has_happy_path: hasHappyPath,
        },
        full_structural_load_count: getFullStructuralLoadCount(),
        stdout_write_count: stdoutWrites.length,
      };
    } finally {
      VaultEngine.sync = originalVaultSync;
    }
  } finally {
    process.stdout.write = originalWrite;
    process.chdir(originalCwd);
    cleanup();
  }
}

/** Campos estáveis para golden (exclui tokens/timestamps e corpos retrieve volumosos). */
export function captureAgentHomologation(
  results: CorpusJourneyResult[],
  options: { captured?: string } = {},
): AgentHomologationCapture {
  const corpora: AgentHomologationCapture["corpora"] = {};
  for (const r of results) {
    // Sequência canônica: retrieve entra no golden quando foi usado (stress).
    corpora[r.corpus_id] = {
      listed_tools: r.listed_tools,
      listed_count: r.listed_count,
      tool_sequence: r.tool_sequence,
      explore_state: r.explore.state,
      explore_truncated: r.explore.truncated,
      explore_actionable: r.explore.actionable,
      explore_snippet_body: r.explore.snippet_body,
      retrieve_used: r.explore.retrieved,
      needle_in_snippet: r.explore.needle_in_snippet,
      needle_in_retrieve: r.explore.needle_in_retrieve,
      remember_state: r.remember_recall.remember_state,
      recall_hit: r.remember_recall.recall_hit,
      sync_called: r.remember_recall.sync_called,
      status_initialized: r.status.initialized,
      status_mcp_slim: r.status.mcp_slim,
      agent_rules_version: r.agent_rules.version,
      full_structural_load_count: r.full_structural_load_count,
      stdout_write_count: r.stdout_write_count,
    };
  }

  return {
    provenance: {
      id: "homologate-agent-v2",
      captured: options.captured ?? new Date().toISOString().slice(0, 10),
      command:
        "npm exec --workspace=@owerride/argus -- vitest run tests/homologate-agent.test.ts",
      runtime_version: ARGUS_VERSION,
      seam: "H6 Client+Server InMemoryTransport → explore/retrieve/remember/recall/status",
      level:
        "ancorada + golden replay (jornada MCP in-process; NÃO mede churn LLM Read/Grep)",
      corpora: HOMOLOGATION_CORPORA.map((c) => ({
        id: c.id,
        size: c.size,
        path: `packages/argus/tests/fixtures/homologation/${c.dirName}`,
      })),
      notes:
        "S8v2/P3: corpus-stress força símbolo > caps balanced → truncate→retrieve com needle no corpo. " +
        "ListTools default inclui remember (5). remember→recall sem memory sync. " +
        "INV-H6: prova = jornada MCP, não agent-facing LLM churn.",
    },
    corpora,
  };
}

export function writeAgentHomologationEvidence(
  capture: AgentHomologationCapture,
  evidenceDir: string,
): void {
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(join(evidenceDir, "agent-latest.json"), `${JSON.stringify(capture, null, 2)}\n`);
  writeFileSync(
    join(evidenceDir, "AGENT_LATEST.md"),
    [
      "# Homologação MCP journey (S8v2)",
      "",
      `- Data: ${capture.provenance.captured}`,
      `- Runtime: ${capture.provenance.runtime_version}`,
      `- Golden: ${capture.provenance.id}`,
      `- Nível: ${capture.provenance.level}`,
      `- Comando: ${capture.provenance.command}`,
      "",
      "| Corpus | ListTools | Truncate | Retrieve | Remember→Recall | Full-load |",
      "|---|---:|---|---|---|---:|",
      ...Object.entries(capture.corpora).map(
        ([id, c]) =>
          `| ${id} | ${c.listed_count} | truncated=${c.explore_truncated} | used=${c.retrieve_used} needle=${c.needle_in_retrieve} | ${c.remember_state} / hit=${c.recall_hit} sync=${c.sync_called} | ${c.full_structural_load_count} |`,
      ),
      "",
    ].join("\n"),
  );
}

// re-export version marker for tests
export { AGENT_RULES_VERSION };
