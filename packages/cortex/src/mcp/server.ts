import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { MCP_SERVER_NAME, MCP_TOOL_NAMES } from "./tool-registry.js";
import { buildToolStub } from "./tools/stubs.js";

const TOOL_INPUT_SCHEMAS = {
  search: z.object({
    query: z.string().min(1),
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
} as const;

const TOOL_INPUT_JSON_SCHEMAS = {
  search: {
    type: "object" as const,
    properties: {
      query: { type: "string" },
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
} as const;

const TOOL_DESCRIPTIONS: Record<(typeof MCP_TOOL_NAMES)[number], string> = {
  search: "Localizar símbolos indexados via FTS local",
  explore: "Entender como algo funciona com contexto estrutural composto",
  trace: "Fluxo/execução provável entre pontos indexados",
  impact: "Blast radius provável de símbolo ou arquivo com risco resumido",
  diff_impact: "Impacto provável do diff Git atual com áreas e testes afetados",
  files: "Estrutura indexada do workspace",
  pack_context: "Empacotar contexto curto para o modelo com refs rastreáveis e handle opcional",
  status: "Saúde, staleness e confiança do índice local",
};

export function createMcpServer(): Server {
  const server = new Server(
    { name: MCP_SERVER_NAME, version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: MCP_TOOL_NAMES.map((name) => ({
      name,
      description: TOOL_DESCRIPTIONS[name],
      inputSchema: TOOL_INPUT_JSON_SCHEMAS[name],
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;

    if (!(MCP_TOOL_NAMES as readonly string[]).includes(toolName)) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              { state: "falha", message: `Tool desconhecida: ${toolName}` },
              null,
              2,
            ),
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
            text: JSON.stringify(
              { state: "falha", message: "Input inválido para a tool" },
              null,
              2,
            ),
          },
        ],
        isError: true,
      };
    }

    const pathArg = typeof args.path === "string" ? args.path : process.cwd();
    const payload = buildToolStub(toolName as (typeof MCP_TOOL_NAMES)[number], pathArg, args);

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(payload, null, 2),
        },
      ],
    };
  });

  return server;
}

export async function startMcpServer(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
