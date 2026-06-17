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
