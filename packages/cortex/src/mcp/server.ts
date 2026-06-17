import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { MCP_SERVER_NAME, MCP_TOOL_NAMES } from "./tool-registry.js";
import { buildToolResponseAsync } from "./tools/response.js";
import { CORTEX_VERSION } from "../version.js";
import { hasDirtyPaths } from "../discovery/dirty-flag.js";
import { isManifestStaleForAutoSync } from "../discovery/staleness.js";
import { runSync } from "../commands/sync.js";

export interface McpServerOptions {
  /** Roda sync incremental antes de cada tool call quando há dirty pendente. */
  autoSync?: boolean;
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
  }).passthrough(),
  retrieve: z.object({
    handle: z.string().regex(/^rh_[a-f0-9]{16}$/),
  }).passthrough(),
  semantic_search: z.object({
    query: z.string().min(1),
    mode: z.enum(["dense", "hybrid"]).optional(),
    scope: z.string().min(1).optional(),
    kind: z.string().min(1).optional(),
    limit: z.number().int().positive().max(100).optional(),
  }).passthrough(),
} as const;

const TOOL_INPUT_JSON_SCHEMAS = {
  search: {
    type: "object" as const,
    properties: {
      query: { type: "string" },
      scope: { type: "string" },
      kind: { type: "string" },
      limit: { type: "integer", minimum: 1, maximum: 100 },
    },
    required: ["query"],
    additionalProperties: true,
  },
  explore: {
    type: "object" as const,
    properties: {
      target: { type: "string" },
      mode: { type: "string", enum: ["symbol", "file", "topic"] },
      depth: { type: "integer", minimum: 0, maximum: 5 },
      include_tests: { type: "boolean" },
      budget: { type: "integer", minimum: 1, maximum: 100 },
    },
    required: ["target"],
    additionalProperties: true,
  },
  trace: {
    type: "object" as const,
    properties: {
      from: { type: "string" },
      to: { type: "string" },
      direction: { type: "string", enum: ["forward", "backward", "both"] },
      max_hops: { type: "integer", minimum: 1, maximum: 6 },
    },
    required: ["from"],
    additionalProperties: true,
  },
  impact: {
    type: "object" as const,
    properties: {
      target: { type: "string" },
      direction: { type: "string", enum: ["dependents", "dependencies", "both"] },
      depth: { type: "integer", minimum: 1, maximum: 8 },
      include_tests: { type: "boolean" },
      summary_only: { type: "boolean" },
    },
    required: ["target"],
    additionalProperties: true,
  },
  files: {
    type: "object" as const,
    properties: {
      pattern: { type: "string" },
      max_depth: { type: "integer", minimum: 0, maximum: 32 },
    },
    additionalProperties: true,
  },
  status: {
    type: "object" as const,
    properties: {
      path: { type: "string" },
    },
    additionalProperties: true,
  },
  diff_impact: {
    type: "object" as const,
    properties: {
      scope: { type: "string", enum: ["unstaged", "staged", "all", "compare"] },
      base_ref: { type: "string" },
    },
    additionalProperties: true,
  },
  pack_context: {
    type: "object" as const,
    properties: {
      sources: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
      },
      goal: { type: "string" },
      token_budget: { type: "integer", minimum: 1, maximum: 8000 },
      style: { type: "string", enum: ["brief", "balanced", "deep"] },
    },
    required: ["sources", "goal", "token_budget"],
    additionalProperties: true,
  },
  retrieve: {
    type: "object" as const,
    properties: {
      handle: { type: "string", pattern: "^rh_[a-f0-9]{16}$" },
    },
    required: ["handle"],
    additionalProperties: false,
  },
  semantic_search: {
    type: "object" as const,
    properties: {
      query: { type: "string" },
      mode: { type: "string", enum: ["dense", "hybrid"] },
      scope: { type: "string" },
      kind: { type: "string" },
      limit: { type: "integer", minimum: 1, maximum: 100 },
    },
    required: ["query"],
    additionalProperties: true,
  },
} as const;

const TOOL_DESCRIPTIONS: Record<(typeof MCP_TOOL_NAMES)[number], string> = {
  search: "Localizar símbolos indexados via FTS local",
  explore: "Entender como algo funciona com contexto estrutural composto",
  trace: "Fluxo/execução provável entre pontos indexados",
  impact: "Blast radius provável de símbolo ou arquivo com risco resumido",
  diff_impact: "Impacto provável do diff Git atual com áreas e testes afetados",
  files: "Estrutura indexada do workspace",
  pack_context: "Empacotar contexto curto para o modelo com refs rastreáveis e handle opcional",
  retrieve: "Recuperar explicitamente conteúdo original de um retrieve_handle local",
  status: "Saúde, staleness e confiança do índice local",
  semantic_search: "Busca semântica densa (embeddings) com fusão híbrida; use quando o lexical vier vazio",
};

export function createMcpServer(options: McpServerOptions = {}): Server {
  const autoSync = options.autoSync !== false;
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
    { name: MCP_SERVER_NAME, version: CORTEX_VERSION },
    { capabilities: { tools: {} } },
  );

  // `response_format` é aceito por toda tool (default `concise`): envelope
  // mínimo (state + códigos `E_*`); `detailed` restaura message/limitations/
  // staleness_hint em prosa. Injetado em todo inputSchema para descoberta pelo
  // agente; o passthrough das schemas zod já o deixa fluir até `buildToolResponse`.
  const withResponseFormat = (schema: { properties: Record<string, unknown> }) => ({
    ...schema,
    properties: {
      ...schema.properties,
      response_format: {
        type: "string" as const,
        enum: ["concise", "detailed"],
        description: "concise (default, mínimo tokens) | detailed (prosa completa)",
      },
    },
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: MCP_TOOL_NAMES.map((name) => ({
      name,
      description: TOOL_DESCRIPTIONS[name],
      inputSchema: withResponseFormat(TOOL_INPUT_JSON_SCHEMAS[name]),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;

    if (!(MCP_TOOL_NAMES as readonly string[]).includes(toolName)) {
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

    const schema = TOOL_INPUT_SCHEMAS[toolName as keyof typeof TOOL_INPUT_SCHEMAS];

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
    const payload = await buildToolResponseAsync(
      toolName as (typeof MCP_TOOL_NAMES)[number],
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
