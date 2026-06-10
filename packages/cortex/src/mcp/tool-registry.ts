/** Nomes congelados das oito tools MCP públicas (S02) */
export const MCP_TOOL_NAMES = [
  "search",
  "explore",
  "trace",
  "impact",
  "diff_impact",
  "files",
  "pack_context",
  "status",
] as const;

export type McpToolName = (typeof MCP_TOOL_NAMES)[number];

export const MCP_SERVER_NAME = "atlas-cortex";

export function isMcpToolName(name: string): name is McpToolName {
  return (MCP_TOOL_NAMES as readonly string[]).includes(name);
}
