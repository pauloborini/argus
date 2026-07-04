import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ARGUS_VERSION } from "../version.js";
import { ARGUS_WORKSPACE_ROOT_ENV } from "../workspace/resolve-serve-root.js";

/** Chave do servidor Argus nos configs MCP (idempotência por chave). */
export const MCP_SERVER_KEY = "argus";

export type McpHostId = "claude-code" | "cursor" | "codex" | "opencode" | "pi" | "antigravity" | "zcode" | "vscode";

export const SUPPORTED_HOSTS: McpHostId[] = [
  "claude-code",
  "cursor",
  "codex",
  "opencode",
  "pi",
  "antigravity",
  "zcode",
  "vscode",
];

/** Escopo de registro: por-repo (`local`) ou para todos os projetos (`global`). */
export type McpScope = "local" | "global";

interface McpServerEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** Pi: mantém o processo stdio vivo entre tool calls (auto-conexão). */
  lifecycle?: "keep-alive";
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
 * Adapter de host: encapsula onde e como o servidor Argus é registrado num
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
 * Entrada base do servidor Argus: node absoluto + cli.js absoluto + `serve
 * --mcp`. Caminhos absolutos evitam depender do `argus` estar no PATH do host.
 *
 * Escopo local: fixa `ARGUS_WORKSPACE_ROOT` no env (path absoluto do repo) para
 * hosts que não propagam cwd. Escopo global: o `serve` descobre o workspace via
 * env do host (`WORKSPACE_FOLDER_PATHS`, etc.) ou registry do daemon.
 */
function buildServerEntry(scope?: McpScope, repoRoot?: string, host?: McpHostId): McpServerEntry {
  const entry: McpServerEntry = {
    command: process.execPath,
    args: [resolveCliEntry(), "serve", "--mcp"],
  };
  if (scope === "local" && repoRoot) {
    entry.env = { [ARGUS_WORKSPACE_ROOT_ENV]: resolve(repoRoot) };
  }
  if (host === "pi") {
    entry.lifecycle = "keep-alive";
  }
  return entry;
}

function sameServerEntry(a: McpServerEntry | undefined, b: McpServerEntry): boolean {
  return (
    !!a &&
    a.command === b.command &&
    JSON.stringify(a.args) === JSON.stringify(b.args) &&
    JSON.stringify(a.env ?? {}) === JSON.stringify(b.env ?? {}) &&
    (a.cwd ?? "") === (b.cwd ?? "") &&
    (a.lifecycle ?? "") === (b.lifecycle ?? "")
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

/**
 * Config global do Claude Code para MCP user-scope: `~/.claude.json` (top-level
 * `mcpServers`) — o MESMO arquivo que `claude mcp add -s user` edita.
 * NÃO é `~/.claude/settings.json`: o settings.json só honra permissions/hooks/
 * env/model/statusLine/enable*Mcp*; um bloco `mcpServers` ali é ignorado.
 * CLAUDE_CONFIG_HOME sobrescreve o dir home (usado em testes p/ não tocar a máquina).
 */
function claudeGlobalConfigPath(): string {
  return join(process.env.CLAUDE_CONFIG_HOME ?? homedir(), ".claude.json");
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
      const entry = buildServerEntry(scope, repoRoot, spec.id);
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

function buildOpencodeEntry(scope?: McpScope, repoRoot?: string): OpencodeServerEntry {
  const entry = buildServerEntry(scope, repoRoot);
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
    const entry = buildOpencodeEntry(scope, repoRoot);
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

interface CodexMcpTransport {
  type?: string;
  command?: string;
  args?: string[];
}

interface CodexMcpServerConfig {
  transport?: CodexMcpTransport;
}

function getCodexMcpConfig(): CodexMcpServerConfig | undefined {
  try {
    const raw = execFileSync("codex", ["mcp", "get", "--json", MCP_SERVER_KEY], {
      encoding: "utf-8",
      timeout: 10_000,
    });
    return JSON.parse(raw) as CodexMcpServerConfig;
  } catch {
    return undefined;
  }
}

function sameCodexServerEntry(config: CodexMcpServerConfig | undefined, entry: McpServerEntry): boolean {
  const transport = config?.transport;
  return (
    transport?.type === "stdio" &&
    transport.command === entry.command &&
    JSON.stringify(transport.args ?? []) === JSON.stringify(entry.args)
  );
}

const codexAdapter: HostAdapter = {
  id: "codex",
  scopes: ["global"],
  register(_repoRoot, _scope) {
    if (!hasBinary("codex")) {
      return { host: "codex", ok: true, changed: false, message: "codex: não detectado (CLI ausente no PATH)" };
    }
    const entry = buildServerEntry("global");
    const existing = getCodexMcpConfig();
    if (sameCodexServerEntry(existing, entry)) {
      return { host: "codex", ok: true, changed: false, message: "codex: já registrado" };
    }
    try {
      if (existing) {
        execFileSync("codex", ["mcp", "remove", MCP_SERVER_KEY], { stdio: "ignore", timeout: 10_000 });
      }
      execFileSync(
        "codex",
        ["mcp", "add", MCP_SERVER_KEY, "--", entry.command, ...entry.args],
        { stdio: "ignore", timeout: 10_000 },
      );
      return {
        host: "codex",
        ok: true,
        changed: true,
        message: existing ? "codex: atualizado via 'codex mcp remove/add'" : "codex: registrado via 'codex mcp add'",
      };
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
// `lifecycle: keep-alive` mantém o processo stdio entre tool calls (auto-conexão).
// INVARIANTE: scope local resolve para `.mcp.json` — mesmo path de claude-code.
// A chave é idêntica (`argus`); unregister deduplicado por path evita
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
// Adapter ZCode: plugin descoberto via marketplace.
//
// ZCode NÃO lê `.mcp.json` de projeto nem escaneia `cache/` arbitrário — só
// carrega plugins listados em `marketplaces/<marketplace>/marketplace.json`,
// cada entry com `cachePath` apontando para `cache/<marketplace>/<plugin>/<version>/`.
// O talos (projeto irmão) usa o mesmo padrão.
//
// Para um plugin de terceiros como o argus, o caminho funcional é:
//   cache/zcode-plugins-official/argus/<version>/
//     ├── .zcode-plugin/plugin.json   (manifesto com mcpServers, skills, license)
//     ├── .zcode-plugin-seed.json     (marketplace: "zcode-plugins-official")
//     └── skills/argus/SKILL.md       (skill mínima — todo plugin do ZCode tem)
//   marketplaces/zcode-plugins-official/marketplace.json   (entry argus adicionada)
//   cli/config.json → enabledPlugins["argus@zcode-plugins-official"] = true
//
// MCP: o server entry usa `cwd`+`env` (sem `transport`) — o ZCode resolve isso
// via plugin host mechanism (compatível com android-emulator, ios-simulator).
// `cwd: ${ZCODE_PROJECT_DIR}` faz o argus achar `.argus/` no workspace atual.
//
// ZCODE_CONFIG_HOME sobrescreve ~/.zcode (escape para Windows ou custom path).
// ---------------------------------------------------------------------------

/** Marketplace do ZCode onde o argus é publicado (mesmo canal dos oficiais). */
const ZCODE_MARKETPLACE = "zcode-plugins-official";

/** Enable key no config.json: "<plugin>@<marketplace>". */
const ZCODE_PLUGIN_ENABLE_KEY = `argus@${ZCODE_MARKETPLACE}`;

function zcodeHome(): string {
  return process.env.ZCODE_CONFIG_HOME ?? join(homedir(), ".zcode");
}

/** Raiz do cache de plugins do ZCode. */
function zcodePluginsRoot(): string {
  return join(zcodeHome(), "cli", "plugins");
}

/** Diretório do plugin argus dentro do cache do marketplace. */
function zcodePluginDir(): string {
  return join(zcodePluginsRoot(), "cache", ZCODE_MARKETPLACE, "argus", ARGUS_VERSION);
}

function zcodePluginJsonPath(): string {
  return join(zcodePluginDir(), ".zcode-plugin", "plugin.json");
}

function zcodeSeedPath(): string {
  return join(zcodePluginDir(), ".zcode-plugin-seed.json");
}

/** Caminho do SKILL.md mínimo do plugin (todo plugin do ZCode tem skills/). */
function zcodeSkillPath(): string {
  return join(zcodePluginDir(), "skills", "argus", "SKILL.md");
}

/** Caminho do marketplace.json onde o argus é registrado. */
function zcodeMarketplaceJsonPath(): string {
  return join(zcodePluginsRoot(), "marketplaces", ZCODE_MARKETPLACE, "marketplace.json");
}

/** Conteúdo do SKILL.md mínimo do plugin argus. */
const ZCODE_ARGUS_SKILL_MD = `# Argus

Argus CLI – indexação estrutural e busca semântica local para codebases.
As tools MCP ficam disponíveis automaticamente quando o plugin está habilitado.
`;

/**
 * Manifesto do plugin argus para o ZCode. Sem `transport` no server entry:
 * o ZCode usa plugin host mechanism quando há cwd/env (mesmo padrão de
 * android-emulator e ios-simulator).
 */
function buildZcodePluginConfig() {
  const entry = buildServerEntry("global");
  return {
    name: "argus",
    version: ARGUS_VERSION,
    description: "Argus CLI – indexação estrutural e busca semântica local para codebases",
    author: { name: "Paulo Borini" },
    license: "MIT",
    skills: "./skills/",
    mcpServers: {
      [MCP_SERVER_KEY]: {
        command: entry.command,
        args: entry.args,
        cwd: "${ZCODE_PROJECT_DIR}",
        env: {
          [ARGUS_WORKSPACE_ROOT_ENV]: "${ZCODE_PROJECT_DIR}",
        },
      },
    },
  };
}

/** Conteúdo canônico do seed.json do plugin. */
function buildZcodeSeed() {
  return {
    hash: "",
    marketplace: ZCODE_MARKETPLACE,
    plugin: "argus",
    pluginVersion: ARGUS_VERSION,
    source: "filesystem",
    version: 1,
  };
}

/** Caminho do config.json do ZCode CLI (~/.zcode/cli/config.json). */
function zcodeCliConfigPath(): string {
  return join(zcodeHome(), "cli", "config.json");
}

interface ZCodeCliConfig {
  plugins?: {
    enabledPlugins?: Record<string, boolean>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface ZcodeMarketplaceEntry {
  cachePath: string;
  name: string;
  source: string;
  version: string;
}

interface ZcodeMarketplace {
  name: string;
  plugins: ZcodeMarketplaceEntry[];
  version?: number;
  [key: string]: unknown;
}

/**
 * Registra (ou atualiza) a entry argus no marketplace.json do ZCode.
 * Preserva outras entries e chaves — merge idempotente por `name`.
 */
function registerInZcodeMarketplace(): { changed: boolean; error?: string } {
  const mpPath = zcodeMarketplaceJsonPath();
  try {
    let marketplace: ZcodeMarketplace;
    if (existsSync(mpPath)) {
      marketplace = readJson<ZcodeMarketplace>(mpPath);
      if (!Array.isArray(marketplace.plugins)) {
        marketplace.plugins = [];
      }
    } else {
      marketplace = { name: ZCODE_MARKETPLACE, plugins: [] };
    }

    const expectedEntry: ZcodeMarketplaceEntry = {
      cachePath: zcodePluginDir(),
      name: "argus",
      source: "filesystem",
      version: ARGUS_VERSION,
    };

    const idx = marketplace.plugins.findIndex((p) => p.name === "argus");
    if (idx >= 0) {
      const existing = marketplace.plugins[idx];
      if (
        existing.cachePath === expectedEntry.cachePath &&
        existing.version === expectedEntry.version &&
        existing.source === expectedEntry.source
      ) {
        return { changed: false };
      }
      marketplace.plugins[idx] = expectedEntry;
    } else {
      marketplace.plugins.push(expectedEntry);
    }

    writeJson(mpPath, marketplace);
    return { changed: true };
  } catch (err) {
    return { changed: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Remove a entry argus do marketplace.json (idempotente).
 * Preserva demais entries e o arquivo se vazio (não deixa cache órfão).
 */
function unregisterFromZcodeMarketplace(): { changed: boolean; error?: string } {
  const mpPath = zcodeMarketplaceJsonPath();
  if (!existsSync(mpPath)) {
    return { changed: false };
  }
  try {
    const marketplace = readJson<ZcodeMarketplace>(mpPath);
    if (!Array.isArray(marketplace.plugins)) {
      return { changed: false };
    }
    const idx = marketplace.plugins.findIndex((p) => p.name === "argus");
    if (idx < 0) {
      return { changed: false };
    }
    marketplace.plugins.splice(idx, 1);
    writeJson(mpPath, marketplace);
    return { changed: true };
  } catch (err) {
    return { changed: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Habilita o plugin argus no config.json do ZCode (idempotente). */
function enableZcodePlugin(): { changed: boolean; error?: string } {
  const configPath = zcodeCliConfigPath();
  try {
    const config = readJson<ZCodeCliConfig>(configPath);
    const plugins = config.plugins ?? {};
    const enabled = plugins.enabledPlugins ?? {};
    if (enabled[ZCODE_PLUGIN_ENABLE_KEY]) {
      return { changed: false };
    }
    enabled[ZCODE_PLUGIN_ENABLE_KEY] = true;
    plugins.enabledPlugins = enabled;
    config.plugins = plugins;
    writeJson(configPath, config);
    return { changed: true };
  } catch (err) {
    return { changed: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Remove o plugin argus do enabledPlugins do ZCode.
 * Também limpa enable keys legacy ("argus@user") de versões anteriores.
 */
function disableZcodePlugin(): { changed: boolean; error?: string } {
  const configPath = zcodeCliConfigPath();
  if (!existsSync(configPath)) {
    return { changed: false };
  }
  try {
    const config = readJson<ZCodeCliConfig>(configPath);
    const enabled = config.plugins?.enabledPlugins;
    if (!enabled) {
      return { changed: false };
    }
    let changed = false;
    // Remove a chave canônica e a legacy "argus@user" (versões antigas).
    for (const key of [ZCODE_PLUGIN_ENABLE_KEY, "argus@user"]) {
      if (key in enabled) {
        delete enabled[key];
        changed = true;
      }
    }
    if (changed) {
      writeJson(configPath, config);
    }
    return { changed };
  } catch (err) {
    return { changed: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Migra instalações legacy: versões antigas do adapter gravavam o plugin em
 * `cache/argus/` (fora de qualquer marketplace) com `marketplace: "user"` no
 * seed e enable key `argus@user`. Essa combinação nunca foi descoberta pelo
 * ZCode. Detecta e remove o diretório órfão para não deixar lixo.
 */
function migrateLegacyZcodeInstall(): { migrated: boolean; details: string[] } {
  const details: string[] = [];
  const legacyDir = join(zcodePluginsRoot(), "cache", "argus");

  // 1. Remove diretório legacy cache/argus/ (se existir e diferente do canônico)
  if (existsSync(legacyDir) && legacyDir !== zcodePluginDir()) {
    try {
      rmSync(legacyDir, { recursive: true, force: true });
      details.push("cache/argus/ legacy removido");
    } catch {
      // não-fatal: o novo install funciona independentemente
    }
  }

  // 2. Limpa enable key legacy "argus@user" do config.json
  const configPath = zcodeCliConfigPath();
  if (existsSync(configPath)) {
    try {
      const config = readJson<ZCodeCliConfig>(configPath);
      const enabled = config.plugins?.enabledPlugins;
      if (enabled && "argus@user" in enabled) {
        delete enabled["argus@user"];
        writeJson(configPath, config);
        details.push("argus@user legacy removido do config.json");
      }
    } catch {
      // não-fatal
    }
  }

  return { migrated: details.length > 0, details };
}

/**
 * Verifica se a instalação atual está completa e consistente:
 * plugin.json + seed + skills + marketplace.json entry + enable key.
 */
function isZcodeInstallComplete(): boolean {
  if (!existsSync(zcodePluginJsonPath())) return false;
  if (!existsSync(zcodeSeedPath())) return false;
  if (!existsSync(zcodeSkillPath())) return false;

  // marketplace.json com entry argus
  const mpPath = zcodeMarketplaceJsonPath();
  if (!existsSync(mpPath)) return false;
  try {
    const mp = readJson<ZcodeMarketplace>(mpPath);
    const entry = mp.plugins?.find((p) => p.name === "argus");
    if (!entry || entry.cachePath !== zcodePluginDir()) return false;
  } catch {
    return false;
  }

  // enable key no config.json
  const configPath = zcodeCliConfigPath();
  if (!existsSync(configPath)) return false;
  try {
    const config = readJson<ZCodeCliConfig>(configPath);
    if (!config.plugins?.enabledPlugins?.[ZCODE_PLUGIN_ENABLE_KEY]) return false;
  } catch {
    return false;
  }

  return true;
}

const zcodeAdapter: HostAdapter = {
  id: "zcode",
  scopes: ["global"],
  register(_repoRoot, _scope) {
    try {
      // Migra instalações legacy antes de instalar o formato canônico.
      const migration = migrateLegacyZcodeInstall();

      // Instalação completa: plugin.json + seed + skills + marketplace + enable
      if (isZcodeInstallComplete()) {
        // Reescreve plugin.json/seed se o conteúdo mudou (ex.: version bump)
        const existing = JSON.parse(readFileSync(zcodePluginJsonPath(), "utf-8"));
        const canonical = buildZcodePluginConfig();
        const canonicalServer = canonical.mcpServers[MCP_SERVER_KEY];
        const existingServer = existing?.mcpServers?.[MCP_SERVER_KEY];
        const needsUpdate =
          !sameServerEntry(existingServer, canonicalServer) ||
          existing?.version !== ARGUS_VERSION ||
          existing?.skills !== canonical.skills ||
          "transport" in (existingServer ?? {});

        if (!needsUpdate) {
          const parts = ["zcode: plugin já registrado"];
          if (migration.migrated) parts.push(`(migrado: ${migration.details.join(", ")})`);
          return { host: "zcode", ok: true, changed: migration.migrated, message: parts.join(" ") };
        }
      }

      // Escreve todos os arquivos do plugin
      mkdirSync(join(zcodePluginDir(), ".zcode-plugin"), { recursive: true });
      mkdirSync(dirname(zcodeSkillPath()), { recursive: true });

      writeJson(zcodePluginJsonPath(), buildZcodePluginConfig());
      writeJson(zcodeSeedPath(), buildZcodeSeed());
      writeFileSync(zcodeSkillPath(), ZCODE_ARGUS_SKILL_MD, "utf-8");

      // Registra no marketplace.json
      const mpResult = registerInZcodeMarketplace();

      // Habilita no config.json
      const enableResult = enableZcodePlugin();

      const parts: string[] = [`zcode: plugin registrado em ${zcodePluginDir()}`];
      if (mpResult.changed) parts.push("adicionado ao marketplace.json");
      if (mpResult.error) parts.push(`(marketplace: ${mpResult.error})`);
      if (enableResult.changed) parts.push("habilitado no config.json");
      if (enableResult.error) parts.push(`(config.json: ${enableResult.error})`);
      if (migration.migrated) parts.push(`(migrado: ${migration.details.join(", ")})`);

      return { host: "zcode", ok: true, changed: true, message: parts.join(", ") };
    } catch (err) {
      return errorResult("zcode", err);
    }
  },
  unregister(_repoRoot, _scope) {
    const parts: string[] = [];
    let changed = false;

    // 1. Remove do marketplace.json
    const mpResult = unregisterFromZcodeMarketplace();
    if (mpResult.changed) {
      changed = true;
      parts.push("removido do marketplace.json");
    }

    // 2. Desabilita no config.json (limpa canônico + legacy)
    const disabled = disableZcodePlugin();
    if (disabled.changed) {
      changed = true;
      parts.push("removido do config.json");
    }

    // 3. Remove os arquivos do plugin
    if (existsSync(zcodePluginDir())) {
      try {
        rmSync(zcodePluginDir(), { recursive: true, force: true });
        changed = true;
        parts.push("plugin removido");
      } catch (err) {
        return errorResult("zcode", err);
      }
    }

    // 4. Limpa diretório legacy cache/argus/ se existir (versões antigas)
    const legacyDir = join(zcodePluginsRoot(), "cache", "argus");
    if (existsSync(legacyDir)) {
      try {
        rmSync(legacyDir, { recursive: true, force: true });
        changed = true;
        parts.push("cache/argus/ legacy removido");
      } catch {
        // não-fatal
      }
    }

    if (parts.length === 0) {
      return {
        host: "zcode",
        ok: true,
        changed: false,
        message: "zcode: plugin não encontrado",
      };
    }
    return {
      host: "zcode",
      ok: true,
      changed,
      message: `zcode: ${parts.join(", ")}`,
    };
  },
  isPresent() {
    return existsSync(zcodeHome());
  },
};

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
  // Claude Code: local → .mcp.json na raiz do repo; global → ~/.claude.json
  // (top-level mcpServers, user-scope — mesmo arquivo do `claude mcp add -s user`).
  // Default = local (env ARGUS_WORKSPACE_ROOT com path absoluto do repo).
  "claude-code": makeMcpServersAdapter({
    id: "claude-code",
    scopes: ["local", "global"],
    configPath: (root, scope) =>
      scope === "global" ? claudeGlobalConfigPath() : join(root, ".mcp.json"),
  }),
  // Cursor: local → .cursor/mcp.json no repo; global → ~/.cursor/mcp.json.
  // Default = local (env ARGUS_WORKSPACE_ROOT com path absoluto do repo).
  // CURSOR_CONFIG_HOME sobrescreve ~ (usado em testes para não tocar a máquina real).
  cursor: makeMcpServersAdapter({
    id: "cursor",
    scopes: ["local", "global"],
    configPath: (root, scope) =>
      scope === "global"
        ? join(process.env.CURSOR_CONFIG_HOME ?? homedir(), ".cursor", "mcp.json")
        : join(root, ".cursor", "mcp.json"),
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
  antigravity: {
    id: "antigravity",
    scopes: ["global"],
    register(repoRoot, scope) {
      const bases = process.env.ANTIGRAVITY_CONFIG_DIR
        ? [process.env.ANTIGRAVITY_CONFIG_DIR]
        : [
          join(homedir(), ".gemini", "antigravity"),
          join(homedir(), ".gemini", "antigravity-ide"),
        ];

      let anyChanged = false;
      let allOk = true;
      const messages: string[] = [];

      for (const base of bases) {
        const adapter = makeMcpServersAdapter({
          id: "antigravity",
          scopes: ["global"],
          configPath: () => join(base, "mcp_config.json"),
        });
        const res = adapter.register(repoRoot, scope);
        if (!res.ok) {
          allOk = false;
        }
        if (res.changed) {
          anyChanged = true;
        }
        messages.push(res.message);
      }

      return {
        host: "antigravity",
        ok: allOk,
        changed: anyChanged,
        message: messages.join(" | "),
      };
    },
    unregister(repoRoot, scope) {
      const bases = process.env.ANTIGRAVITY_CONFIG_DIR
        ? [process.env.ANTIGRAVITY_CONFIG_DIR]
        : [
          join(homedir(), ".gemini", "antigravity"),
          join(homedir(), ".gemini", "antigravity-ide"),
        ];

      let anyChanged = false;
      let allOk = true;
      const messages: string[] = [];

      for (const base of bases) {
        const adapter = makeMcpServersAdapter({
          id: "antigravity",
          scopes: ["global"],
          configPath: () => join(base, "mcp_config.json"),
        });
        const res = adapter.unregister(repoRoot, scope);
        if (!res.ok) {
          allOk = false;
        }
        if (res.changed) {
          anyChanged = true;
        }
        messages.push(res.message);
      }

      return {
        host: "antigravity",
        ok: allOk,
        changed: anyChanged,
        message: messages.join(" | "),
      };
    },
    isPresent() {
      if (process.env.ANTIGRAVITY_CONFIG_DIR) {
        return existsSync(process.env.ANTIGRAVITY_CONFIG_DIR);
      }
      return (
        existsSync(join(homedir(), ".gemini", "antigravity")) ||
        existsSync(join(homedir(), ".gemini", "antigravity-ide"))
      );
    },
  },
  zcode: zcodeAdapter,
  // VS Code: local → .vscode/mcp.json no repo; global → ~/.vscode/mcp.json.
  // Default = local (env ARGUS_WORKSPACE_ROOT com path absoluto do repo).
  // VSCODE_CONFIG_HOME sobrescreve ~ (usado em testes para não tocar a máquina real).
  vscode: makeMcpServersAdapter({
    id: "vscode",
    scopes: ["local", "global"],
    configPath: (root, scope) =>
      scope === "global"
        ? join(process.env.VSCODE_CONFIG_HOME ?? homedir(), ".vscode", "mcp.json")
        : join(root, ".vscode", "mcp.json"),
    detectBinary: "code",
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
 * (file-based, idioma de projeto) sempre; codex/opencode/pi/antigravity/zcode/vscode
 * só quando detectados nesta máquina (auto-detecção, evita criar config de host não usado).
 */
export function resolveDefaultHosts(repoRoot: string, requested?: McpScope): McpHostId[] {
  const always: McpHostId[] = ["claude-code", "cursor"];
  const detected = (["codex", "opencode", "pi", "antigravity", "zcode", "vscode"] as McpHostId[]).filter((id) =>
    ADAPTERS[id].isPresent(repoRoot, effectiveScope(id, requested).scope),
  );
  return [...always, ...detected];
}

/**
 * Registra o servidor Argus em cada host alvo, idempotente e **preservando**
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
      return scope === "global" ? claudeGlobalConfigPath() : join(repoRoot, ".mcp.json");
    case "cursor":
      return scope === "global"
        ? join(process.env.CURSOR_CONFIG_HOME ?? homedir(), ".cursor", "mcp.json")
        : join(repoRoot, ".cursor", "mcp.json");
    case "opencode":
      return opencodeConfigPath(repoRoot, scope);
    case "pi":
      return piConfigPath(repoRoot, scope);
    case "antigravity":
      return join(
        process.env.ANTIGRAVITY_CONFIG_DIR ?? join(homedir(), ".gemini", "antigravity"),
        "mcp_config.json",
      );
    case "zcode":
      return zcodeMarketplaceJsonPath();
    case "vscode":
      return scope === "global"
        ? join(process.env.VSCODE_CONFIG_HOME ?? homedir(), ".vscode", "mcp.json")
        : join(repoRoot, ".vscode", "mcp.json");
    case "codex":
      return undefined; // delega ao CLI, sem arquivo direto
  }
}

/** Remove o servidor Argus de cada host alvo (preserva os demais).
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
