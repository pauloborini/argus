import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { MCP_SERVER_NAME, isMcpToolName, resolveListedTools, buildMcpToolDefinitions } from "./tool-registry.js";
import { buildToolResponseAsync, buildToolResponseTsv } from "./tools/response.js";
import { ARGUS_VERSION } from "../version.js";
import { hasDirtyPaths } from "../discovery/dirty-flag.js";
import { isManifestStaleForAutoSync } from "../discovery/staleness.js";
import { runSync } from "../commands/sync.js";

export interface McpServerOptions {
  /** Roda sync incremental antes de cada tool call quando há dirty pendente. */
  autoSync?: boolean;
  /**
   * Override de `ARGUS_MCP_TOOLS` (testes). Ausente = lê process.env.
   * Mudança em runtime exige novo `createMcpServer` (restart MCP).
   */
  listedToolsEnv?: string | undefined;
}

const TOOL_INPUT_SCHEMAS = {
  search: z.object({
    query: z.string().min(1),
    scope: z.string().min(1).optional(),
    kind: z.string().min(1).optional(),
    limit: z.number().int().positive().max(100).optional(),
  }).passthrough(),
  explore: z.object({
    target: z.string().min(1),
    mode: z.enum(["symbol", "file", "topic"]).optional(),
    depth: z.number().int().nonnegative().max(5).optional(),
    include_tests: z.boolean().optional(),
    budget: z.number().int().positive().max(100).optional(),
  }).passthrough(),
  trace: z.object({
    from: z.string().min(1),
    to: z.string().min(1).optional(),
    direction: z.enum(["forward", "backward", "both"]).optional(),
    max_hops: z.number().int().positive().max(6).optional(),
  }).passthrough(),
  impact: z.object({
    target: z.string().min(1),
    direction: z.enum(["dependents", "dependencies", "both"]).optional(),
    depth: z.number().int().positive().max(8).optional(),
    include_tests: z.boolean().optional(),
    summary_only: z.boolean().optional(),
  }).passthrough(),
  files: z.object({
    pattern: z.string().min(1).optional(),
    max_depth: z.number().int().nonnegative().max(32).optional(),
  }).passthrough(),
  status: z.object({
    path: z.string().min(1).optional(),
  }).passthrough(),
  diff_impact: z.object({
    scope: z.enum(["unstaged", "staged", "all", "compare"]).optional(),
    base_ref: z.string().min(1).optional(),
  }).passthrough(),
  pack_context: z.object({
    sources: z.array(z.string().min(1)).min(1),
    goal: z.string().min(1),
    token_budget: z.number().int().positive().max(8000),
    style: z.enum(["brief", "balanced", "deep"]).optional(),
    synthesize: z.boolean().optional(),
  }).passthrough(),
  retrieve: z.object({
    handle: z.string().regex(/^(rh|mh)_[a-f0-9]{16}$/),
    context_lines: z.number().int().min(0).max(100).optional(),
  }).passthrough(),
  semantic_search: z.object({
    query: z.string().min(1),
    mode: z.enum(["dense", "hybrid"]).optional(),
    domain: z.enum(["code", "memory", "all"]).optional(),
    scope: z.string().min(1).optional(),
    kind: z.string().min(1).optional(),
    limit: z.number().int().positive().max(100).optional(),
  }).passthrough(),
  remember: z.object({
    content: z.string().min(1),
    type: z.enum(["inbox", "decision", "meeting", "entity", "project", "reference"]).optional(),
    tags: z.array(z.string()).optional(),
    links: z.array(z.string()).optional(),
  }).passthrough(),
  recall: z.object({
    query: z.string().min(1),
    limit: z.number().int().positive().max(50).optional(),
    include_snippets: z.boolean().optional(),
  }).passthrough(),
} as const;

export function createMcpServer(options: McpServerOptions = {}): Server {
  const autoSync = options.autoSync !== false;
  // Política de descoberta resolvida no boot: ListTools usa listed; CallTool usa all.
  // `listedToolsEnv` permite testes isolarem a env sem mutar process.env globalmente.
  const listedResolution =
    "listedToolsEnv" in options
      ? resolveListedTools(options.listedToolsEnv)
      : resolveListedTools();
  const listedDefinitions = buildMcpToolDefinitions(listedResolution.listed);
  // Ancora o auto-sync no cwd do server (onde o workspace foi validado em
  // `runServeMcp`), não no cwd do momento da tool call — mantém a leitura da
  // dirty-flag e o sync sobre o mesmo workspace que as tools resolvem.
  const rootCwd = process.cwd();
  // Lock simples: serializa syncs e evita corrida entre tool calls paralelas.
  let inFlight: Promise<void> | null = null;

  async function autoSyncIfDirty(): Promise<void> {
    if (!autoSync) {
      return;
    }
    // Loop até a flag estar limpa: cobre a corrida em que um novo evento sujo
    // chega enquanto outra tool call já tinha um sync em andamento. Quem aguarda
    // um `inFlight` alheio re-checa a flag; se ainda houver trabalho, roda o seu.
    while (hasDirtyPaths(rootCwd)) {
      if (inFlight) {
        await inFlight;
        continue;
      }
      let cleared = false;
      inFlight = (async () => {
        try {
          // Erro de sync nunca derruba o servidor: a query degrada para `parcial`
          // + staleness_hint pela própria leitura do índice.
          // `quiet`: o transporte stdio do MCP é dono do stdout; qualquer
          // `console.log` do sync intercalaria texto não-JSON no stream JSON-RPC
          // e derrubaria a sessão. Diagnose vai para stderr.
          await runSync({ cwd: rootCwd, quiet: true });
          cleared = true;
        } catch {
          /* deixa o estado de staleness sinalizar; não trava a tool call */
        } finally {
          inFlight = null;
        }
      })();
      await inFlight;
      // Sync falhou e não limpou a flag: pára para não entrar em loop infinito.
      if (!cleared) {
        break;
      }
    }

    // Fallback Bug 9: com daemon down e sem hooks a dirty-flag nunca é
    // alimentada, então o laço acima nunca dispara e o índice ficaria stale
    // para sempre. Probe barato (memoizado, compartilha o walk que a tool já
    // fará): se o working tree divergiu do manifest, sincroniza uma vez via
    // walk. Sem laço — `runSync` atualiza o manifest e o próximo probe é fresh;
    // se falhar, a tool reporta stale honesto pela leitura do índice.
    if (!hasDirtyPaths(rootCwd) && isManifestStaleForAutoSync(rootCwd)) {
      if (inFlight) {
        await inFlight;
      } else {
        inFlight = (async () => {
          try {
            await runSync({ cwd: rootCwd, quiet: true });
          } catch {
            /* deixa o estado de staleness sinalizar; não trava a tool call */
          } finally {
            inFlight = null;
          }
        })();
        await inFlight;
      }
    }
  }

  const server = new Server(
    { name: MCP_SERVER_NAME, version: ARGUS_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: listedDefinitions,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;

    // Unlisted ≠ desabilitada: validação e dispatch usam o catálogo completo.
    if (!isMcpToolName(toolName)) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ state: "falha", message: `Tool desconhecida: ${toolName}` }),
          },
        ],
        isError: true,
      };
    }

    const schema = TOOL_INPUT_SCHEMAS[toolName];

    let args: Record<string, unknown>;
    try {
      args = schema.parse(request.params.arguments ?? {}) as Record<string, unknown>;
    } catch {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ state: "falha", message: "Input inválido para a tool" }),
          },
        ],
        isError: true,
      };
    }

    // Garante índice fresco antes de responder, consumindo a dirty-flag.
    await autoSyncIfDirty();

    const pathArg = typeof args.path === "string" ? args.path : process.cwd();

    if (args.response_format === "tsv") {
      const { text, truncationNote, isError } = buildToolResponseTsv(
        toolName,
        pathArg,
        args,
      );
      const fullText = truncationNote ? `${text}\n# ${truncationNote}` : text;
      return {
        content: [{ type: "text" as const, text: fullText }],
        isError,
      };
    }

    const payload = await buildToolResponseAsync(
      toolName,
      pathArg,
      args,
    );

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(payload),
        },
      ],
    };
  });

  return server;
}

export async function startMcpServer(options: McpServerOptions = {}): Promise<void> {
  const server = createMcpServer(options);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
