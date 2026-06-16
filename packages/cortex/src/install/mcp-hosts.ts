import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Chave do servidor Cortex nos configs MCP (idempotência por chave). */
export const MCP_SERVER_KEY = "atlas-cortex";

export type McpHostId = "claude-code" | "cursor";

export const SUPPORTED_HOSTS: McpHostId[] = ["claude-code", "cursor"];

interface McpServerEntry {
  command: string;
  args: string[];
}

interface McpConfig {
  mcpServers?: Record<string, McpServerEntry>;
  [key: string]: unknown;
}

interface HostDescriptor {
  id: McpHostId;
  /** Caminho do config MCP do host, relativo à raiz do repo. */
  configPath(repoRoot: string): string;
}

const HOSTS: Record<McpHostId, HostDescriptor> = {
  // Claude Code: config MCP de projeto na raiz do repo. O host sobe o servidor
  // com cwd = raiz do projeto, então o `cortex serve` acha o `.cortex/` local.
  "claude-code": {
    id: "claude-code",
    configPath: (root) => join(root, ".mcp.json"),
  },
  // Cursor: config MCP de projeto em `.cursor/mcp.json`.
  cursor: {
    id: "cursor",
    configPath: (root) => join(root, ".cursor", "mcp.json"),
  },
};

/** Caminho absoluto do CLI compilado (dist/cli.js) a partir deste módulo. */
function resolveCliEntry(): string {
  return fileURLToPath(new URL("../cli.js", import.meta.url));
}

/**
 * Entrada do servidor Cortex: node absoluto + cli.js absoluto + `serve --mcp`.
 * Caminhos absolutos evitam depender do `cortex` estar no PATH do host.
 */
function buildServerEntry(): McpServerEntry {
  return {
    command: process.execPath,
    args: [resolveCliEntry(), "serve", "--mcp"],
  };
}

function readConfig(path: string): McpConfig {
  if (!existsSync(path)) {
    return {};
  }
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as McpConfig;
  } catch {
    // Config ilegível: não sobrescreve às cegas (poderia destruir servers do
    // usuário). Sinaliza via retorno do caller.
    throw new Error(`Config MCP ilegível: ${path}`);
  }
}

function writeConfig(path: string, config: McpConfig): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

export interface HostRegistrationResult {
  host: McpHostId;
  ok: boolean;
  changed: boolean;
  message: string;
}

/**
 * Registra o servidor Cortex no config MCP de cada host alvo, idempotente e
 * **preservando** quaisquer outros servers do usuário (merge por chave, nunca
 * sobrescreve o arquivo inteiro).
 */
export function registerMcpForHosts(
  repoRoot: string,
  hosts: McpHostId[] = SUPPORTED_HOSTS,
): HostRegistrationResult[] {
  const entry = buildServerEntry();
  return hosts.map((id) => {
    const descriptor = HOSTS[id];
    const path = descriptor.configPath(repoRoot);
    try {
      const config = readConfig(path);
      const servers = config.mcpServers ?? {};
      const existing = servers[MCP_SERVER_KEY];
      const same =
        existing &&
        existing.command === entry.command &&
        JSON.stringify(existing.args) === JSON.stringify(entry.args);
      if (same) {
        return { host: id, ok: true, changed: false, message: `${id}: já registrado` };
      }
      servers[MCP_SERVER_KEY] = entry;
      config.mcpServers = servers;
      writeConfig(path, config);
      return { host: id, ok: true, changed: true, message: `${id}: registrado em ${path}` };
    } catch (err) {
      return {
        host: id,
        ok: false,
        changed: false,
        message: `${id}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  });
}

/** Remove o servidor Cortex dos configs MCP dos hosts (preserva os demais). */
export function unregisterMcpForHosts(
  repoRoot: string,
  hosts: McpHostId[] = SUPPORTED_HOSTS,
): HostRegistrationResult[] {
  return hosts.map((id) => {
    const descriptor = HOSTS[id];
    const path = descriptor.configPath(repoRoot);
    if (!existsSync(path)) {
      return { host: id, ok: true, changed: false, message: `${id}: sem config` };
    }
    try {
      const config = readConfig(path);
      if (!config.mcpServers || !(MCP_SERVER_KEY in config.mcpServers)) {
        return { host: id, ok: true, changed: false, message: `${id}: não registrado` };
      }
      delete config.mcpServers[MCP_SERVER_KEY];
      writeConfig(path, config);
      return { host: id, ok: true, changed: true, message: `${id}: removido de ${path}` };
    } catch (err) {
      return {
        host: id,
        ok: false,
        changed: false,
        message: `${id}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  });
}
