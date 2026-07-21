/**
 * S8 — jornada agent-facing MCP (ListTools slim → explore → remember→recall → status).
 * Seam real: Client + Server via InMemoryTransport; sem mock do registry/server/loaders.
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
  "../fixtures/goldens/homologate-agent-v1.json",
);

export interface CorpusSpec {
  id: string;
  size: "small" | "medium";
  dirName: string;
  probeTarget: string;
  probeNeedle: string;
}

export const HOMOLOGATION_CORPORA: readonly CorpusSpec[] = [
  {
    id: "corpus-small",
    size: "small",
    dirName: "corpus-small",
    probeTarget: "calculateTotal",
    probeNeedle: "helper()",
  },
  {
    id: "corpus-medium",
    size: "medium",
    dirName: "corpus-medium",
    probeTarget: "placeOrder",
    probeNeedle: "calculateInvoice",
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
    actionable: boolean;
    snippet_body: string;
    has_retrieve_handle: boolean;
    retrieved: boolean;
  };
  remember_recall: {
    remember_state: string;
    recall_hit: boolean;
    unique_token: string;
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
      explore_actionable: boolean;
      explore_snippet_body: string;
      retrieve_used: boolean;
      remember_state: string;
      recall_hit: boolean;
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
  const temp = mkdtempSync(join(tmpdir(), `argus-s8-${spec.id}-`));
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
    const client = new Client({ name: "homologate-agent-s8", version: ARGUS_VERSION });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const toolSequence: string[] = [];

    const listed = await client.listTools();
    const listedNames = listed.tools.map((t) => t.name);

    const exploreRes = await client.callTool({
      name: "explore",
      arguments: { target: spec.probeTarget, mode: "symbol" },
    });
    toolSequence.push("explore");
    const explorePayload = parseToolJson(exploreRes);
    const snippets = (explorePayload.snippets as Array<{ body?: string; signature?: string }>) ?? [];
    const snippetBody = snippets.map((s) => s.body ?? "").join("\n");
    const signature = snippets.map((s) => s.signature ?? "").join("\n");
    // AC-6.1.1: actionable exige verbatim com o needle do corpus (não só "return"/nome).
    const actionable = snippetBody.includes(spec.probeNeedle);
    const handle =
      typeof explorePayload.retrieve_handle === "string"
        ? explorePayload.retrieve_handle
        : undefined;

    let retrieved = false;
    if (handle) {
      await client.callTool({
        name: "retrieve",
        arguments: { handle, context_lines: 3 },
      });
      toolSequence.push("retrieve");
      retrieved = true;
    }

    const unique = `s8-homolog-${spec.id}-${Date.now()}`;
    const rememberRes = await client.callTool({
      name: "remember",
      arguments: {
        content: `Decisão homologação agent-facing ${unique}`,
        type: "decision",
      },
    });
    toolSequence.push("remember");
    const rememberPayload = parseToolJson(rememberRes);

    const recallRes = await client.callTool({
      name: "recall",
      arguments: { query: unique, limit: 5 },
    });
    toolSequence.push("recall");
    const recallPayload = parseToolJson(recallRes);
    const chunks = (recallPayload.chunks as Array<{ snippet?: string; content?: string }>) ?? [];
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
        actionable,
        snippet_body: snippetBody || signature,
        has_retrieve_handle: Boolean(handle),
        retrieved,
      },
      remember_recall: {
        remember_state: String(rememberPayload.state),
        recall_hit: recallHit,
        unique_token: unique,
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
    process.stdout.write = originalWrite;
    process.chdir(originalCwd);
    cleanup();
  }
}

/** Campos estáveis para golden (exclui tokens/timestamps). */
export function captureAgentHomologation(
  results: CorpusJourneyResult[],
  options: { captured?: string } = {},
): AgentHomologationCapture {
  const corpora: AgentHomologationCapture["corpora"] = {};
  for (const r of results) {
    // Sequência canônica do happy path (retrieve é condicional e não entra no golden).
    const canonicalSequence = r.tool_sequence.filter((t) => t !== "retrieve");
    corpora[r.corpus_id] = {
      listed_tools: r.listed_tools,
      listed_count: r.listed_count,
      tool_sequence: canonicalSequence,
      explore_state: r.explore.state,
      explore_actionable: r.explore.actionable,
      explore_snippet_body: r.explore.snippet_body,
      retrieve_used: r.explore.retrieved,
      remember_state: r.remember_recall.remember_state,
      recall_hit: r.remember_recall.recall_hit,
      status_initialized: r.status.initialized,
      status_mcp_slim: r.status.mcp_slim,
      agent_rules_version: r.agent_rules.version,
      full_structural_load_count: r.full_structural_load_count,
      stdout_write_count: r.stdout_write_count,
    };
  }

  return {
    provenance: {
      id: "homologate-agent-v1",
      captured: options.captured ?? new Date().toISOString().slice(0, 10),
      command:
        "npm exec --workspace=@owerride/argus -- vitest run tests/homologate-agent.test.ts",
      runtime_version: ARGUS_VERSION,
      seam: "S8 host/processo → MCP → payload/memória/status/regras",
      level: "golden replay (protocolo MCP in-process; corpora fixtures)",
      corpora: HOMOLOGATION_CORPORA.map((c) => ({
        id: c.id,
        size: c.size,
        path: `packages/argus/tests/fixtures/homologation/${c.dirName}`,
      })),
      notes:
        "Q1: corpus-small + corpus-medium versionados no repo. retrieve só entra na sequência live se explore emitir handle.",
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
      "# Homologação agent-facing (S8)",
      "",
      `- Data: ${capture.provenance.captured}`,
      `- Runtime: ${capture.provenance.runtime_version}`,
      `- Golden: ${capture.provenance.id}`,
      `- Comando: ${capture.provenance.command}`,
      "",
      "| Corpus | ListTools | Explore | Remember→Recall | Full-load |",
      "|---|---:|---|---|---:|",
      ...Object.entries(capture.corpora).map(
        ([id, c]) =>
          `| ${id} | ${c.listed_count} | ${c.explore_state} / actionable=${c.explore_actionable} | ${c.remember_state} / hit=${c.recall_hit} | ${c.full_structural_load_count} |`,
      ),
      "",
    ].join("\n"),
  );
}

// re-export version marker for tests
export { AGENT_RULES_VERSION };
