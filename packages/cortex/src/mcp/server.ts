import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { MCP_SERVER_NAME, MCP_TOOL_NAMES } from "./tool-registry.js";
import { buildToolStub } from "./tools/stubs.js";

const toolInputSchema = z.object({}).passthrough();

const TOOL_DESCRIPTIONS: Record<(typeof MCP_TOOL_NAMES)[number], string> = {
  search: "Localizar símbolos, arquivos e configs indexados (stub S03)",
  explore: "Entender como algo funciona — tool principal (stub S03)",
  trace: "Fluxo/execução provável entre pontos (stub S03)",
  impact: "Blast radius de símbolo ou arquivo (stub S03)",
  diff_impact: "Impacto do diff Git atual (stub S03)",
  files: "Estrutura indexada do workspace (stub S03)",
  pack_context: "Empacotar contexto curto para o modelo (stub S03)",
  status: "Saúde, staleness e confiança do índice (stub S03)",
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
      inputSchema: {
        type: "object" as const,
        properties: {},
        additionalProperties: true,
      },
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

    try {
      toolInputSchema.parse(request.params.arguments ?? {});
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

    const payload = buildToolStub(toolName as (typeof MCP_TOOL_NAMES)[number]);

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
