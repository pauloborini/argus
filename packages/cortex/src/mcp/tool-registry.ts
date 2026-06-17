/** Surface pública do runtime maduro (S19 adiciona retrieve explícito). */
export const MCP_TOOL_NAMES = [
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
] as const;

export type McpToolName = (typeof MCP_TOOL_NAMES)[number];

export const MCP_SERVER_NAME = "atlas-cortex";

export function isMcpToolName(name: string): name is McpToolName {
  return (MCP_TOOL_NAMES as readonly string[]).includes(name);
}

// `response_format` injetado em toda tool; `tsv` só válido em search/files.
const RESPONSE_FORMAT_SCHEMA = {
  type: "string" as const,
  enum: ["concise", "detailed", "tsv"],
  description:
    "concise (default, mínimo tokens) | detailed (prosa completa) | tsv (tabular, apenas search/files)",
};

export const TOOL_INPUT_JSON_SCHEMAS = {
  search: {
    type: "object" as const,
    properties: {
      query: { type: "string" },
      scope: { type: "string" },
      kind: { type: "string" },
      limit: { type: "integer", minimum: 1, maximum: 100 },
      response_format: RESPONSE_FORMAT_SCHEMA,
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
      response_format: RESPONSE_FORMAT_SCHEMA,
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
      response_format: RESPONSE_FORMAT_SCHEMA,
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
      response_format: RESPONSE_FORMAT_SCHEMA,
    },
    required: ["target"],
    additionalProperties: true,
  },
  files: {
    type: "object" as const,
    properties: {
      pattern: { type: "string" },
      max_depth: { type: "integer", minimum: 0, maximum: 32 },
      response_format: RESPONSE_FORMAT_SCHEMA,
    },
    additionalProperties: true,
  },
  status: {
    type: "object" as const,
    properties: {
      path: { type: "string" },
      response_format: RESPONSE_FORMAT_SCHEMA,
    },
    additionalProperties: true,
  },
  diff_impact: {
    type: "object" as const,
    properties: {
      scope: { type: "string", enum: ["unstaged", "staged", "all", "compare"] },
      base_ref: { type: "string" },
      response_format: RESPONSE_FORMAT_SCHEMA,
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
      response_format: RESPONSE_FORMAT_SCHEMA,
    },
    required: ["sources", "goal", "token_budget"],
    additionalProperties: true,
  },
  retrieve: {
    type: "object" as const,
    properties: {
      handle: { type: "string", pattern: "^rh_[a-f0-9]{16}$" },
      response_format: RESPONSE_FORMAT_SCHEMA,
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
      response_format: RESPONSE_FORMAT_SCHEMA,
    },
    required: ["query"],
    additionalProperties: true,
  },
} as const;

export const TOOL_DESCRIPTIONS: Record<McpToolName, string> = {
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

/** Array de tools com name + description + inputSchema — para descoberta pelo agente. */
export const tools = MCP_TOOL_NAMES.map((name) => ({
  name,
  description: TOOL_DESCRIPTIONS[name],
  inputSchema: TOOL_INPUT_JSON_SCHEMAS[name],
}));
