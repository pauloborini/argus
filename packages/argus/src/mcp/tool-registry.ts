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
  "remember",
  "recall",
] as const;

export type McpToolName = (typeof MCP_TOOL_NAMES)[number];

export const MCP_SERVER_NAME = "argus";

/** Env que controla quais tools aparecem em ListTools (não afeta CallTool). */
export const ARGUS_MCP_TOOLS_ENV = "ARGUS_MCP_TOOLS";

/**
 * Path feliz default (D1/P6): no máximo quatro tools listadas.
 * CallTool continua aceitando o catálogo completo em `MCP_TOOL_NAMES`.
 */
export const DEFAULT_LISTED_MCP_TOOLS: readonly McpToolName[] = [
  "explore",
  "pack_context",
  "recall",
  "status",
] as const;

export type ListedToolsMode = "default" | "all" | "explicit";

export interface ListedToolsResolution {
  /** Tools expostas em ListTools. */
  listed: readonly McpToolName[];
  mode: ListedToolsMode;
  /** Env inválida/vazia caiu no default seguro (nunca abre as 12 silenciosamente). */
  usedFallback: boolean;
  /** Diagnóstico acionável quando a env é rejeitada. */
  warning?: string;
  /** Valor bruto da env (undefined se ausente). */
  rawEnv?: string;
}

export function isMcpToolName(name: string): name is McpToolName {
  return (MCP_TOOL_NAMES as readonly string[]).includes(name);
}

function emitListedToolsDiagnostic(message: string): void {
  // Stdio MCP: stdout é protocolo JSON-RPC; diagnose só em stderr.
  console.error(message);
}

/**
 * Resolve a política de descoberta (ListTools) a partir de `ARGUS_MCP_TOOLS`.
 * - ausente → default slim (4)
 * - `all` → catálogo completo (12), ordem de `MCP_TOOL_NAMES`
 * - CSV → conjunto pedido, deduplicado, ordem estável da primeira ocorrência
 * - inválida/vazia → warning em stderr + default seguro (não expõe 12)
 *
 * Mudança de env exige restart do processo MCP.
 */
export function resolveListedTools(
  envValue: string | undefined = process.env[ARGUS_MCP_TOOLS_ENV],
  options: { emitDiagnostic?: boolean } = {},
): ListedToolsResolution {
  const emit = options.emitDiagnostic !== false;

  if (envValue === undefined) {
    return {
      listed: DEFAULT_LISTED_MCP_TOOLS,
      mode: "default",
      usedFallback: false,
    };
  }

  const trimmed = envValue.trim();
  if (trimmed === "") {
    const warning =
      `E_MCP_TOOLS_INVALID: ${ARGUS_MCP_TOOLS_ENV} está vazia; ` +
      `usando default slim (${DEFAULT_LISTED_MCP_TOOLS.join(",")}). ` +
      `Para listar todas: ${ARGUS_MCP_TOOLS_ENV}=all. CallTool já aceita as ${MCP_TOOL_NAMES.length} registradas.`;
    if (emit) {
      emitListedToolsDiagnostic(warning);
    }
    return {
      listed: DEFAULT_LISTED_MCP_TOOLS,
      mode: "default",
      usedFallback: true,
      warning,
      rawEnv: envValue,
    };
  }

  if (trimmed.toLowerCase() === "all") {
    return {
      listed: MCP_TOOL_NAMES,
      mode: "all",
      usedFallback: false,
      rawEnv: envValue,
    };
  }

  const tokens = trimmed
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  if (tokens.length === 0) {
    const warning =
      `E_MCP_TOOLS_INVALID: ${ARGUS_MCP_TOOLS_ENV} não contém nomes; ` +
      `usando default slim (${DEFAULT_LISTED_MCP_TOOLS.join(",")}). ` +
      `Para listar todas: ${ARGUS_MCP_TOOLS_ENV}=all.`;
    if (emit) {
      emitListedToolsDiagnostic(warning);
    }
    return {
      listed: DEFAULT_LISTED_MCP_TOOLS,
      mode: "default",
      usedFallback: true,
      warning,
      rawEnv: envValue,
    };
  }

  const invalid: string[] = [];
  const seen = new Set<McpToolName>();
  const listed: McpToolName[] = [];

  for (const token of tokens) {
    if (!isMcpToolName(token)) {
      invalid.push(token);
      continue;
    }
    if (seen.has(token)) {
      continue;
    }
    seen.add(token);
    listed.push(token);
  }

  if (invalid.length > 0 || listed.length === 0) {
    const detail =
      listed.length === 0
        ? "nenhum nome válido"
        : `nomes inválidos: ${invalid.join(", ")}`;
    const warning =
      `E_MCP_TOOLS_INVALID: ${ARGUS_MCP_TOOLS_ENV} rejeitada (${detail}); ` +
      `usando default slim (${DEFAULT_LISTED_MCP_TOOLS.join(",")}). ` +
      `Válidos: ${MCP_TOOL_NAMES.join(",")}. Ou use ${ARGUS_MCP_TOOLS_ENV}=all.`;
    if (emit) {
      emitListedToolsDiagnostic(warning);
    }
    return {
      listed: DEFAULT_LISTED_MCP_TOOLS,
      mode: "default",
      usedFallback: true,
      warning,
      rawEnv: envValue,
    };
  }

  return {
    listed,
    mode: "explicit",
    usedFallback: false,
    rawEnv: envValue,
  };
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
      synthesize: { type: "boolean" },
      response_format: RESPONSE_FORMAT_SCHEMA,
    },
    required: ["sources", "goal", "token_budget"],
    additionalProperties: true,
  },
  retrieve: {
    type: "object" as const,
    properties: {
      handle: { type: "string", pattern: "^(rh|mh)_[a-f0-9]{16}$" },
      // Body-on-demand: expande origin_refs lendo o disco com ± padding de linhas.
      context_lines: { type: "integer", minimum: 0, maximum: 100 },
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
      domain: { type: "string", enum: ["code", "memory", "all"] },
      scope: { type: "string" },
      kind: { type: "string" },
      limit: { type: "integer", minimum: 1, maximum: 100 },
      response_format: RESPONSE_FORMAT_SCHEMA,
    },
    required: ["query"],
    additionalProperties: true,
  },
  remember: {
    type: "object" as const,
    properties: {
      content: { type: "string" },
      type: { type: "string", enum: ["inbox", "decision", "meeting", "entity", "project", "reference"] },
      tags: { type: "array", items: { type: "string" } },
      links: { type: "array", items: { type: "string" } },
      response_format: RESPONSE_FORMAT_SCHEMA,
    },
    required: ["content"],
    additionalProperties: true,
  },
  recall: {
    type: "object" as const,
    properties: {
      query: { type: "string" },
      limit: { type: "integer", minimum: 1, maximum: 50 },
      include_snippets: { type: "boolean" },
      response_format: RESPONSE_FORMAT_SCHEMA,
    },
    required: ["query"],
    additionalProperties: true,
  },
} as const;

export const TOOL_DESCRIPTIONS: Record<McpToolName, string> = {
  search: "Localizar símbolos indexados via FTS local (avançada; invocável mesmo se unlisted)",
  explore:
    "Path feliz para entendimento/refactor: contexto estrutural composto (símbolo, arquivo ou tema)",
  trace: "Fluxo/execução provável entre pontos indexados (avançada; invocável mesmo se unlisted)",
  impact:
    "Blast radius provável de símbolo ou arquivo com risco resumido (avançada; invocável mesmo se unlisted)",
  diff_impact:
    "Impacto provável do diff Git atual com áreas e testes afetados (avançada; invocável mesmo se unlisted)",
  files: "Estrutura indexada do workspace (avançada; invocável mesmo se unlisted)",
  pack_context:
    "Reunir múltiplas fontes sob budget de tokens com refs rastreáveis e handle opcional",
  retrieve:
    "Recuperar conteúdo original de um retrieve_handle local (avançada; handle já vem do pack/explore)",
  status:
    "Saúde, staleness, confiança do índice e modo slim da surface MCP (ARGUS_MCP_TOOLS=all restaura ListTools completo)",
  semantic_search:
    "Busca semântica densa (embeddings) com fusão híbrida; fallback quando o lexical vier vazio (avançada; unlisted por default)",
  remember:
    "Capturar nota, decisão ou insight no cofre local (avançada; unlisted por default — use recall para ler)",
  recall: "Recuperar decisões e fatos do cofre local com FTS/híbrido, sem LLM",
};

/** Definições MCP para um conjunto de nomes (ListTools / descoberta). */
export function buildMcpToolDefinitions(names: readonly McpToolName[]) {
  return names.map((name) => ({
    name,
    description: TOOL_DESCRIPTIONS[name],
    inputSchema: TOOL_INPUT_JSON_SCHEMAS[name],
  }));
}

/**
 * Catálogo completo (registered). ListTools deve usar `resolveListedTools` +
 * `buildMcpToolDefinitions`; CallTool valida contra `MCP_TOOL_NAMES`.
 */
export const tools = buildMcpToolDefinitions(MCP_TOOL_NAMES);
