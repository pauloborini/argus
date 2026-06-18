import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Chave do servidor Cortex nos configs MCP (idempotência por chave). */
export const MCP_SERVER_KEY = "atlas-cortex";

export type McpHostId = "claude-code" | "cursor" | "codex" | "opencode" | "pi";

export const SUPPORTED_HOSTS: McpHostId[] = [
  "claude-code",
  "cursor",
  "codex",
  "opencode",
  "pi",
];

/** Escopo de registro: por-repo (`local`) ou para todos os projetos (`global`). */
export type McpScope = "local" | "global";

interface McpServerEntry {
  command: string;
  args: string[];
}

interface McpConfig {
  mcpServers?: Record<string, McpServerEntry>;
  [key: string]: unknown;
}

/** Forma de servidor do OpenCode: `command` como array único + `type`. */
interface OpencodeServerEntry {
  type: "local";
  command: string[];
  enabled: boolean;
}

interface OpencodeConfig {
  mcp?: Record<string, OpencodeServerEntry>;
  [key: string]: unknown;
}

export interface HostRegistrationResult {
  host: McpHostId;
  ok: boolean;
  changed: boolean;
  message: string;
}

/**
 * Adapter de host: encapsula onde e como o servidor Cortex é registrado num
 * host MCP. As variações (JSON `mcpServers`, JSON `mcp` do OpenCode, delegação
 * ao CLI do Codex) ficam atrás de uma interface uniforme — o resto do código
 * (install/uninstall) não conhece host-específico.
 */
interface HostAdapter {
  id: McpHostId;
  /** Escopos suportados; o primeiro é o default quando nenhum é forçado. */
  scopes: McpScope[];
  register(repoRoot: string, scope: McpScope): HostRegistrationResult;
  unregister(repoRoot: string, scope: McpScope): HostRegistrationResult;
  /** True se o host está instalado/configurado nesta máquina (auto-detecção). */
  isPresent(repoRoot: string, scope: McpScope): boolean;
}

// ---------------------------------------------------------------------------
// Entrada do servidor (caminhos absolutos: não dependem do PATH/cwd do host)
// ---------------------------------------------------------------------------

/** Caminho absoluto do CLI compilado (dist/cli.js) a partir deste módulo. */
function resolveCliEntry(): string {
  return fileURLToPath(new URL("../cli.js", import.meta.url));
}

/**
 * Entrada base do servidor Cortex: node absoluto + cli.js absoluto + `serve
 * --mcp`. Caminhos absolutos evitam depender do `cortex` estar no PATH do host
 * e funcionam igual em registro global (sem cwd do projeto).
 */
function buildServerEntry(): McpServerEntry {
  return {
    command: process.execPath,
    args: [resolveCliEntry(), "serve", "--mcp"],
  };
}

function sameServerEntry(a: McpServerEntry | undefined, b: McpServerEntry): boolean {
  return (
    !!a && a.command === b.command && JSON.stringify(a.args) === JSON.stringify(b.args)
  );
}

// ---------------------------------------------------------------------------
// Helpers de config JSON (merge por chave, nunca sobrescreve o arquivo inteiro)
// ---------------------------------------------------------------------------

/**
 * Remove comentários single-line (`// ...`) de texto JSON (JSONC leve).
 * Respeita strings: ignora `//` dentro de aspas. Não trata block comments
 * (raro em configs MCP) — suficiente para opencode.json e editores humanos.
 */
function stripJsonComments(text: string): string {
  return text.replace(
    /("(?:[^"\\]|\\.)*")|\/\/[^\n]*/g,
    (_match, quoted: string | undefined) => (quoted ? quoted : ""),
  );
}

function readJson<T>(path: string): T {
  if (!existsSync(path)) {
    return {} as T;
  }
  try {
    const raw = readFileSync(path, "utf-8");
    return JSON.parse(stripJsonComments(raw)) as T;
  } catch {
    // Config ilegível: não sobrescreve às cegas (poderia destruir servers do
    // usuário). Sinaliza via exceção para o caller reportar.
    throw new Error(`Config MCP ilegível: ${path}`);
  }
}

function writeJson(path: string, config: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

/** Raiz de config do usuário (XDG no Unix, APPDATA no Windows). */
function userConfigHome(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) {
    return xdg;
  }
  if (process.platform === "win32" && process.env.APPDATA) {
    return process.env.APPDATA;
  }
  return join(homedir(), ".config");
}

/** True se o binário está no PATH (auto-detecção de hosts via CLI). */
function hasBinary(name: string): boolean {
  const probe = process.platform === "win32" ? "where" : "which";
  try {
    execFileSync(probe, [name], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Adapter genérico: JSON na forma `mcpServers` (claude-code, cursor, pi)
// ---------------------------------------------------------------------------

interface McpServersAdapterSpec {
  id: McpHostId;
  scopes: McpScope[];
  /** Resolve o path do config para o escopo dado. */
  configPath(repoRoot: string, scope: McpScope): string;
  /** Detecção opcional além da existência do config (ex.: binário no PATH). */
  detectBinary?: string;
}

function makeMcpServersAdapter(spec: McpServersAdapterSpec): HostAdapter {
  return {
    id: spec.id,
    scopes: spec.scopes,
    register(repoRoot, scope) {
      const path = spec.configPath(repoRoot, scope);
      const entry = buildServerEntry();
      try {
        const config = readJson<McpConfig>(path);
        const servers = config.mcpServers ?? {};
        if (sameServerEntry(servers[MCP_SERVER_KEY], entry)) {
          return { host: spec.id, ok: true, changed: false, message: `${spec.id}: já registrado` };
        }
        servers[MCP_SERVER_KEY] = entry;
        config.mcpServers = servers;
        writeJson(path, config);
        return { host: spec.id, ok: true, changed: true, message: `${spec.id}: registrado em ${path}` };
      } catch (err) {
        return errorResult(spec.id, err);
      }
    },
    unregister(repoRoot, scope) {
      const path = spec.configPath(repoRoot, scope);
      if (!existsSync(path)) {
        return { host: spec.id, ok: true, changed: false, message: `${spec.id}: sem config` };
      }
      try {
        const config = readJson<McpConfig>(path);
        if (!config.mcpServers || !(MCP_SERVER_KEY in config.mcpServers)) {
          return { host: spec.id, ok: true, changed: false, message: `${spec.id}: não registrado` };
        }
        delete config.mcpServers[MCP_SERVER_KEY];
        writeJson(path, config);
        return { host: spec.id, ok: true, changed: true, message: `${spec.id}: removido de ${path}` };
      } catch (err) {
        return errorResult(spec.id, err);
      }
    },
    isPresent(repoRoot, scope) {
      if (existsSync(spec.configPath(repoRoot, scope))) {
        return true;
      }
      return spec.detectBinary ? hasBinary(spec.detectBinary) : false;
    },
  };
}

// ---------------------------------------------------------------------------
// Adapter OpenCode: JSON na forma `mcp` (entry `type:"local"`, command array)
// ---------------------------------------------------------------------------

function opencodeConfigPath(repoRoot: string, scope: McpScope): string {
  return scope === "global"
    ? join(userConfigHome(), "opencode", "opencode.json")
    : join(repoRoot, "opencode.json");
}

function buildOpencodeEntry(): OpencodeServerEntry {
  const entry = buildServerEntry();
  return { type: "local", command: [entry.command, ...entry.args], enabled: true };
}

function sameOpencodeEntry(
  a: OpencodeServerEntry | undefined,
  b: OpencodeServerEntry,
): boolean {
  return !!a && a.type === b.type && JSON.stringify(a.command) === JSON.stringify(b.command);
}

const opencodeAdapter: HostAdapter = {
  id: "opencode",
  scopes: ["global", "local"],
  register(repoRoot, scope) {
    const path = opencodeConfigPath(repoRoot, scope);
    const entry = buildOpencodeEntry();
    try {
      const config = readJson<OpencodeConfig>(path);
      const servers = config.mcp ?? {};
      if (sameOpencodeEntry(servers[MCP_SERVER_KEY], entry)) {
        return { host: "opencode", ok: true, changed: false, message: "opencode: já registrado" };
      }
      servers[MCP_SERVER_KEY] = entry;
      config.mcp = servers;
      writeJson(path, config);
      return { host: "opencode", ok: true, changed: true, message: `opencode: registrado em ${path}` };
    } catch (err) {
      return errorResult("opencode", err);
    }
  },
  unregister(repoRoot, scope) {
    const path = opencodeConfigPath(repoRoot, scope);
    if (!existsSync(path)) {
      return { host: "opencode", ok: true, changed: false, message: "opencode: sem config" };
    }
    try {
      const config = readJson<OpencodeConfig>(path);
      if (!config.mcp || !(MCP_SERVER_KEY in config.mcp)) {
        return { host: "opencode", ok: true, changed: false, message: "opencode: não registrado" };
      }
      delete config.mcp[MCP_SERVER_KEY];
      writeJson(path, config);
      return { host: "opencode", ok: true, changed: true, message: `opencode: removido de ${path}` };
    } catch (err) {
      return errorResult("opencode", err);
    }
  },
  isPresent(repoRoot, scope) {
    return existsSync(opencodeConfigPath(repoRoot, scope)) || hasBinary("opencode");
  },
};

// ---------------------------------------------------------------------------
// Adapter Codex: delega ao CLI `codex mcp add/remove`. Evita editar o
// `~/.codex/config.toml` na mão (preserva comentários/formatação do usuário).
// ---------------------------------------------------------------------------

function codexMcpExists(): boolean {
  try {
    execFileSync("codex", ["mcp", "get", MCP_SERVER_KEY], { stdio: "ignore", timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

const codexAdapter: HostAdapter = {
  id: "codex",
  scopes: ["global"],
  register(_repoRoot, _scope) {
    if (!hasBinary("codex")) {
      return { host: "codex", ok: true, changed: false, message: "codex: não detectado (CLI ausente no PATH)" };
    }
    if (codexMcpExists()) {
      return { host: "codex", ok: true, changed: false, message: "codex: já registrado" };
    }
    const entry = buildServerEntry();
    try {
      execFileSync(
        "codex",
        ["mcp", "add", MCP_SERVER_KEY, "--", entry.command, ...entry.args],
        { stdio: "ignore", timeout: 10_000 },
      );
      return { host: "codex", ok: true, changed: true, message: "codex: registrado via 'codex mcp add'" };
    } catch (err) {
      return errorResult("codex", err);
    }
  },
  unregister(_repoRoot, _scope) {
    if (!hasBinary("codex")) {
      return { host: "codex", ok: true, changed: false, message: "codex: não detectado (CLI ausente no PATH)" };
    }
    if (!codexMcpExists()) {
      return { host: "codex", ok: true, changed: false, message: "codex: não registrado" };
    }
    try {
      execFileSync("codex", ["mcp", "remove", MCP_SERVER_KEY], { stdio: "ignore", timeout: 10_000 });
      return { host: "codex", ok: true, changed: true, message: "codex: removido via 'codex mcp remove'" };
    } catch (err) {
      return errorResult("codex", err);
    }
  },
  isPresent(_repoRoot, _scope) {
    return hasBinary("codex");
  },
};

// ---------------------------------------------------------------------------
// Pi: JSON `mcpServers` global em ~/.pi/agent/mcp.json (honra
// PI_CODING_AGENT_DIR) ou `.mcp.json` no repo (local).
// INVARIANTE: scope local resolve para `.mcp.json` — mesmo path de claude-code.
// A chave é idêntica (`atlas-cortex`); unregister deduplicado por path evita
// remover entry que outro adapter ainda espera. Se Pi mudar de forma, separar.
// ---------------------------------------------------------------------------

function piConfigPath(repoRoot: string, scope: McpScope): string {
  if (scope === "global") {
    const piDir =
      process.env.PI_CODING_AGENT_DIR ??
      (process.platform === "win32"
        ? join(process.env.APPDATA ?? homedir(), ".pi", "agent")
        : join(homedir(), ".pi", "agent"));
    return join(piDir, "mcp.json");
  }
  return join(repoRoot, ".mcp.json");
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

function errorResult(id: McpHostId, err: unknown): HostRegistrationResult {
  return {
    host: id,
    ok: false,
    changed: false,
    message: `${id}: ${err instanceof Error ? err.message : String(err)}`,
  };
}

const ADAPTERS: Record<McpHostId, HostAdapter> = {
  // Claude Code: config MCP de projeto na raiz do repo. O host sobe o servidor
  // com cwd = raiz do projeto, então o `cortex serve` acha o `.cortex/` local.
  "claude-code": makeMcpServersAdapter({
    id: "claude-code",
    scopes: ["local"],
    configPath: (root) => join(root, ".mcp.json"),
  }),
  // Cursor: config MCP de projeto em `.cursor/mcp.json`.
  cursor: makeMcpServersAdapter({
    id: "cursor",
    scopes: ["local"],
    configPath: (root) => join(root, ".cursor", "mcp.json"),
  }),
  codex: codexAdapter,
  opencode: opencodeAdapter,
  // Pi (pi.dev): mesma forma `mcpServers` do Claude.
  pi: makeMcpServersAdapter({
    id: "pi",
    scopes: ["global", "local"],
    configPath: piConfigPath,
    detectBinary: "pi",
  }),
};

/** Escopo efetivo de um host: o solicitado se suportado, senão o default dele. */
export function effectiveScope(host: McpHostId, requested?: McpScope): { scope: McpScope; downgraded: boolean } {
  const adapter = ADAPTERS[host];
  if (requested && adapter.scopes.includes(requested)) {
    return { scope: requested, downgraded: false };
  }
  return { scope: adapter.scopes[0], downgraded: !!requested };
}

/**
 * Hosts a fiar por default quando `--hosts` não é dado: claude-code e cursor
 * (file-based, idioma de projeto) sempre; codex/opencode/pi só quando
 * detectados nesta máquina (auto-detecção, evita criar config de host não usado).
 */
export function resolveDefaultHosts(repoRoot: string, requested?: McpScope): McpHostId[] {
  const always: McpHostId[] = ["claude-code", "cursor"];
  const detected = (["codex", "opencode", "pi"] as McpHostId[]).filter((id) =>
    ADAPTERS[id].isPresent(repoRoot, effectiveScope(id, requested).scope),
  );
  return [...always, ...detected];
}

/**
 * Registra o servidor Cortex em cada host alvo, idempotente e **preservando**
 * quaisquer outros servers do usuário (merge por chave / delegação ao CLI do
 * host, nunca sobrescreve o arquivo inteiro).
 */
export function registerMcpForHosts(
  repoRoot: string,
  hosts: McpHostId[] = SUPPORTED_HOSTS,
  scope?: McpScope,
): HostRegistrationResult[] {
  return hosts.map((id) => {
    const { scope: eff, downgraded } = effectiveScope(id, scope);
    const result = ADAPTERS[id].register(repoRoot, eff);
    if (downgraded && result.ok) {
      result.message += ` (escopo forçado p/ ${eff} — host não suporta '${scope}')`;
    }
    return result;
  });
}

/**
 * Resolve o path do config que um adapter usaria para o escopo dado. Retorna
 * `undefined` para adapters que não usam arquivo (ex.: codex delega ao CLI).
 */
function resolveConfigPath(id: McpHostId, repoRoot: string, scope: McpScope): string | undefined {
  switch (id) {
    case "claude-code":
      return join(repoRoot, ".mcp.json");
    case "cursor":
      return join(repoRoot, ".cursor", "mcp.json");
    case "opencode":
      return opencodeConfigPath(repoRoot, scope);
    case "pi":
      return piConfigPath(repoRoot, scope);
    case "codex":
      return undefined; // delega ao CLI, sem arquivo direto
  }
}

/** Remove o servidor Cortex de cada host alvo (preserva os demais).
 * Sem scope explícito → limpa todos os escopos suportados pelo host.
 * Deduplicado por configPath: se dois adapters resolvem pro mesmo arquivo
 * (ex.: pi local + claude-code ambos em `.mcp.json`), executa uma vez só.
 */
export function unregisterMcpForHosts(
  repoRoot: string,
  hosts: McpHostId[] = SUPPORTED_HOSTS,
  scope?: McpScope,
): HostRegistrationResult[] {
  const seen = new Set<string>();
  const results: HostRegistrationResult[] = [];

  for (const id of hosts) {
    const adapter = ADAPTERS[id];
    const scopes = scope ? [effectiveScope(id, scope).scope] : adapter.scopes;

    for (const s of scopes) {
      // Deduplicar por path real (evita remover entry que outro adapter compartilha)
      const configKey = resolveConfigPath(id, repoRoot, s);
      if (configKey && seen.has(configKey)) {
        results.push({ host: id, ok: true, changed: false, message: `${id}: já limpo por outro host (${configKey})` });
        continue;
      }
      if (configKey) {
        seen.add(configKey);
      }
      results.push(adapter.unregister(repoRoot, s));
    }
  }
  return results;
}
