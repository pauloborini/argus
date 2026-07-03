import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:os", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:os")>();
  return {
    ...original,
    homedir: () => {
      return (globalThis as any).__fakeHomedir || original.homedir();
    },
  };
});
import {
  registerMcpForHosts,
  unregisterMcpForHosts,
  resolveDefaultHosts,
  effectiveScope,
  MCP_SERVER_KEY,
} from "../src/install/mcp-hosts.js";
import { ARGUS_VERSION } from "../src/version.js";

interface JsonRecord {
  [key: string]: unknown;
}

function readJson(path: string): JsonRecord {
  return JSON.parse(readFileSync(path, "utf-8")) as JsonRecord;
}

describe("mcp-hosts adapters", () => {
  let repo: string;
  let savedPiDir: string | undefined;
  let savedXdg: string | undefined;
  let savedAntigravityDir: string | undefined;
  let savedClaudeConfigHome: string | undefined;
  let savedCursorConfigHome: string | undefined;
  let savedZcodeConfigHome: string | undefined;

  beforeEach(() => {
    repo = mkdtempSync(join(os.tmpdir(), "argus-hosts-"));
    savedPiDir = process.env.PI_CODING_AGENT_DIR;
    savedXdg = process.env.XDG_CONFIG_HOME;
    savedAntigravityDir = process.env.ANTIGRAVITY_CONFIG_DIR;
    savedClaudeConfigHome = process.env.CLAUDE_CONFIG_HOME;
    savedCursorConfigHome = process.env.CURSOR_CONFIG_HOME;
    savedZcodeConfigHome = process.env.ZCODE_CONFIG_HOME;
    // Aponta os escopos globais para dentro do tmp (sem tocar a máquina real).
    process.env.PI_CODING_AGENT_DIR = join(repo, "home-pi", "agent");
    process.env.XDG_CONFIG_HOME = join(repo, "home-config");
    process.env.ANTIGRAVITY_CONFIG_DIR = join(repo, "home-antigravity");
    process.env.CLAUDE_CONFIG_HOME = join(repo, "home-claude");
    process.env.CURSOR_CONFIG_HOME = join(repo, "home-cursor");
    process.env.ZCODE_CONFIG_HOME = join(repo, "home-zcode");
  });

  afterEach(() => {
    if (repo && existsSync(repo)) {
      rmSync(repo, { recursive: true, force: true });
    }
    process.env.PI_CODING_AGENT_DIR = savedPiDir;
    process.env.XDG_CONFIG_HOME = savedXdg;
    process.env.ANTIGRAVITY_CONFIG_DIR = savedAntigravityDir;
    process.env.CLAUDE_CONFIG_HOME = savedClaudeConfigHome;
    process.env.CURSOR_CONFIG_HOME = savedCursorConfigHome;
    process.env.ZCODE_CONFIG_HOME = savedZcodeConfigHome;
  });

  it("claude-code: escopo local (default) registra em .mcp.json com ARGUS_WORKSPACE_ROOT", () => {
    const first = registerMcpForHosts(repo, ["claude-code"]);
    expect(first[0].ok).toBe(true);
    expect(first[0].changed).toBe(true);

    const path = join(repo, ".mcp.json");
    expect(existsSync(path)).toBe(true);
    const servers = readJson(path).mcpServers as JsonRecord;
    const entry = servers[MCP_SERVER_KEY] as JsonRecord;
    expect(entry).toBeDefined();
    expect((entry.env as JsonRecord).ARGUS_WORKSPACE_ROOT).toBe(repo);

    const second = registerMcpForHosts(repo, ["claude-code"]);
    expect(second[0].changed).toBe(false);
    expect(second[0].message).toContain("já registrado");
  });

  it("claude-code: escopo global registra em ~/.claude.json (top-level mcpServers)", () => {
    const res = registerMcpForHosts(repo, ["claude-code"], "global");
    expect(res[0].ok).toBe(true);
    expect(res[0].changed).toBe(true);

    const path = join(process.env.CLAUDE_CONFIG_HOME!, ".claude.json");
    const servers = readJson(path).mcpServers as JsonRecord;
    expect(servers[MCP_SERVER_KEY]).toBeDefined();
  });

  it("claude-code: escopo local (opt-in explícito) registra em .mcp.json", () => {
    const res = registerMcpForHosts(repo, ["claude-code"], "local");
    expect(res[0].ok).toBe(true);
    expect(res[0].changed).toBe(true);
    expect(existsSync(join(repo, ".mcp.json"))).toBe(true);
  });

  it("claude-code: preserva outros servers e outras chaves do ~/.claude.json (merge por chave)", () => {
    const claudeDir = join(process.env.CLAUDE_CONFIG_HOME!);
    mkdirSync(claudeDir, { recursive: true });
    const path = join(claudeDir, ".claude.json");
    writeFileSync(
      path,
      JSON.stringify({
        mcpServers: { outro: { command: "x", args: [] } },
        permissions: { allow: [] },
      }),
      "utf-8",
    );

    registerMcpForHosts(repo, ["claude-code"], "global");
    const config = readJson(path);
    const servers = config.mcpServers as JsonRecord;
    expect(servers.outro).toBeDefined();
    expect(servers[MCP_SERVER_KEY]).toBeDefined();
    expect(config.permissions).toBeDefined();

    unregisterMcpForHosts(repo, ["claude-code"]);
    const after = readJson(path);
    const serversAfter = after.mcpServers as JsonRecord;
    expect(serversAfter.outro).toBeDefined();
    expect(serversAfter[MCP_SERVER_KEY]).toBeUndefined();
    expect(after.permissions).toBeDefined();
  });

  it("opencode: registra forma mcp/type:local global e preserva outros mcp", () => {
    const path = join(process.env.XDG_CONFIG_HOME!, "opencode", "opencode.json");
    mkdirSync(join(process.env.XDG_CONFIG_HOME!, "opencode"), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({ mcp: { outro: { type: "local", command: ["x"], enabled: true } } }),
      "utf-8",
    );

    const res = registerMcpForHosts(repo, ["opencode"], "global");
    expect(res[0].ok).toBe(true);
    expect(res[0].changed).toBe(true);

    const mcp = readJson(path).mcp as JsonRecord;
    expect(mcp.outro).toBeDefined();
    const entry = mcp[MCP_SERVER_KEY] as JsonRecord;
    expect(entry.type).toBe("local");
    expect(Array.isArray(entry.command)).toBe(true);
    expect(entry.enabled).toBe(true);

    // Idempotência.
    const again = registerMcpForHosts(repo, ["opencode"], "global");
    expect(again[0].changed).toBe(false);
  });

  it("pi: escopo global escreve em PI_CODING_AGENT_DIR/mcp.json com lifecycle keep-alive", () => {
    const globalRes = registerMcpForHosts(repo, ["pi"], "global");
    expect(globalRes[0].ok).toBe(true);
    const globalPath = join(process.env.PI_CODING_AGENT_DIR!, "mcp.json");
    expect(existsSync(globalPath)).toBe(true);
    const entry = (readJson(globalPath).mcpServers as JsonRecord)[MCP_SERVER_KEY] as JsonRecord;
    expect(entry).toBeDefined();
    expect(entry.lifecycle).toBe("keep-alive");

    const localRes = registerMcpForHosts(repo, ["pi"], "local");
    expect(localRes[0].ok).toBe(true);
    expect(existsSync(join(repo, ".mcp.json"))).toBe(true);
    const localEntry = (readJson(join(repo, ".mcp.json")).mcpServers as JsonRecord)[
      MCP_SERVER_KEY
    ] as JsonRecord;
    expect(localEntry.lifecycle).toBe("keep-alive");
  });

  it("antigravity: registra forma mcpServers em ANTIGRAVITY_CONFIG_DIR/mcp_config.json", () => {
    const res = registerMcpForHosts(repo, ["antigravity"], "global");
    expect(res[0].ok).toBe(true);
    expect(res[0].changed).toBe(true);

    const path = join(process.env.ANTIGRAVITY_CONFIG_DIR!, "mcp_config.json");
    expect(existsSync(path)).toBe(true);
    const config = readJson(path);
    const servers = config.mcpServers as JsonRecord;
    expect(servers[MCP_SERVER_KEY]).toBeDefined();

    // Idempotência
    const res2 = registerMcpForHosts(repo, ["antigravity"], "global");
    expect(res2[0].changed).toBe(false);
  });

  it("antigravity: registra em ambas as pastas padrão se ANTIGRAVITY_CONFIG_DIR não estiver setado", () => {
    const fakeHome = join(repo, "fake-home");
    (globalThis as any).__fakeHomedir = fakeHome;

    const originalEnv = process.env.ANTIGRAVITY_CONFIG_DIR;
    delete process.env.ANTIGRAVITY_CONFIG_DIR;

    try {
      const res = registerMcpForHosts(repo, ["antigravity"], "global");
      expect(res[0].ok).toBe(true);
      expect(res[0].changed).toBe(true);

      const path1 = join(fakeHome, ".gemini", "antigravity", "mcp_config.json");
      const path2 = join(fakeHome, ".gemini", "antigravity-ide", "mcp_config.json");

      expect(existsSync(path1)).toBe(true);
      expect(existsSync(path2)).toBe(true);

      expect(readJson(path1).mcpServers as JsonRecord).toBeDefined();
      expect(readJson(path2).mcpServers as JsonRecord).toBeDefined();

      // Idempotência
      const res2 = registerMcpForHosts(repo, ["antigravity"], "global");
      expect(res2[0].changed).toBe(false);
    } finally {
      delete (globalThis as any).__fakeHomedir;
      process.env.ANTIGRAVITY_CONFIG_DIR = originalEnv;
    }
  });

  it("cursor: escopo local (default) registra em .cursor/mcp.json com ARGUS_WORKSPACE_ROOT", () => {
    const res = registerMcpForHosts(repo, ["cursor"]);
    expect(res[0].ok).toBe(true);
    expect(res[0].changed).toBe(true);

    const path = join(repo, ".cursor", "mcp.json");
    expect(existsSync(path)).toBe(true);
    const entry = (readJson(path).mcpServers as JsonRecord)[MCP_SERVER_KEY] as JsonRecord;
    expect(entry).toBeDefined();
    expect((entry.env as JsonRecord).ARGUS_WORKSPACE_ROOT).toBe(repo);

    const again = registerMcpForHosts(repo, ["cursor"]);
    expect(again[0].changed).toBe(false);
    expect(again[0].message).toContain("já registrado");
  });

  it("cursor: escopo global registra em CURSOR_CONFIG_HOME/.cursor/mcp.json", () => {
    const res = registerMcpForHosts(repo, ["cursor"], "global");
    expect(res[0].ok).toBe(true);
    expect(res[0].changed).toBe(true);

    const path = join(process.env.CURSOR_CONFIG_HOME!, ".cursor", "mcp.json");
    expect(existsSync(path)).toBe(true);
    const servers = readJson(path).mcpServers as JsonRecord;
    expect(servers[MCP_SERVER_KEY]).toBeDefined();
  });

  it("cursor: escopo local (opt-in explícito) registra em .cursor/mcp.json do repo", () => {
    const res = registerMcpForHosts(repo, ["cursor"], "local");
    expect(res[0].ok).toBe(true);
    expect(res[0].changed).toBe(true);
    expect(existsSync(join(repo, ".cursor", "mcp.json"))).toBe(true);
  });

  it("effectiveScope: cursor com scope global é nativo (não rebaixa)", () => {
    const result = effectiveScope("cursor", "global");
    expect(result.scope).toBe("global");
    expect(result.downgraded).toBe(false);
  });

  it("unregister sem scope limpa ambos escopos do cursor (global + local)", () => {
    registerMcpForHosts(repo, ["cursor"], "global");
    registerMcpForHosts(repo, ["cursor"], "local");

    const globalPath = join(process.env.CURSOR_CONFIG_HOME!, ".cursor", "mcp.json");
    const localPath = join(repo, ".cursor", "mcp.json");
    expect(existsSync(globalPath)).toBe(true);
    expect(existsSync(localPath)).toBe(true);

    const results = unregisterMcpForHosts(repo, ["cursor"]);
    const okResults = results.filter((r) => r.ok);
    expect(okResults.length).toBe(2);

    const globalConfig = readJson(globalPath);
    expect((globalConfig.mcpServers as JsonRecord)[MCP_SERVER_KEY]).toBeUndefined();

    const localConfig = readJson(localPath);
    expect((localConfig.mcpServers as JsonRecord)[MCP_SERVER_KEY]).toBeUndefined();
  });

  it("resolveDefaultHosts inclui sempre claude-code e cursor", () => {
    const hosts = resolveDefaultHosts(repo, "global");
    expect(hosts).toContain("claude-code");
    expect(hosts).toContain("cursor");
  });

  it("config ilegível não sobrescreve às cegas (erro reportado)", () => {
    const path = join(repo, ".mcp.json");
    writeFileSync(path, "{ json quebrado", "utf-8");
    const res = registerMcpForHosts(repo, ["claude-code"], "local");
    expect(res[0].ok).toBe(false);
    expect(res[0].message).toContain("ilegível");
  });

  it("config ilegível: arquivo original permanece intacto após erro", () => {
    const path = join(repo, ".mcp.json");
    const broken = "{ json quebrado >>>>";
    writeFileSync(path, broken, "utf-8");
    registerMcpForHosts(repo, ["claude-code"], "local");
    expect(readFileSync(path, "utf-8")).toBe(broken);
  });

  it("effectiveScope: claude-code com scope global não rebaixa (global suportado)", () => {
    const result = effectiveScope("claude-code", "global");
    expect(result.scope).toBe("global");
    expect(result.downgraded).toBe(false);
  });

  it("effectiveScope: pi com scope global não rebaixa", () => {
    const result = effectiveScope("pi", "global");
    expect(result.scope).toBe("global");
    expect(result.downgraded).toBe(false);
  });

  it("claude-code: escopo global escreve em CLAUDE_CONFIG_HOME/.claude.json", () => {
    const res = registerMcpForHosts(repo, ["claude-code"], "global");
    expect(res[0].ok).toBe(true);
    expect(res[0].changed).toBe(true);
    const path = join(process.env.CLAUDE_CONFIG_HOME!, ".claude.json");
    expect(existsSync(path)).toBe(true);
    const servers = (readJson(path).mcpServers ?? {}) as JsonRecord;
    expect(servers[MCP_SERVER_KEY]).toBeDefined();
  });

  it("opencode: config com comentários JSONC é parseada corretamente", () => {
    const dir = join(process.env.XDG_CONFIG_HOME!, "opencode");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "opencode.json");
    writeFileSync(
      path,
      '{\n  // comentário do usuário\n  "mcp": {\n    "outro": { "type": "local", "command": ["x"], "enabled": true }\n  }\n}\n',
      "utf-8",
    );

    const res = registerMcpForHosts(repo, ["opencode"], "global");
    expect(res[0].ok).toBe(true);
    expect(res[0].changed).toBe(true);

    const config = JSON.parse(readFileSync(path, "utf-8"));
    expect(config.mcp.outro).toBeDefined();
    expect(config.mcp[MCP_SERVER_KEY]).toBeDefined();
  });

  it("colisão pi local + claude-code local: unregister de um preserva entry do outro", () => {
    // Ambos registram no mesmo .mcp.json (scope local)
    registerMcpForHosts(repo, ["claude-code"], "local");
    registerMcpForHosts(repo, ["pi"], "local");

    const path = join(repo, ".mcp.json");
    const before = JSON.parse(readFileSync(path, "utf-8"));
    expect(before.mcpServers[MCP_SERVER_KEY]).toBeDefined();

    // Unregister com ambos na lista: deduplicação evita deletar 2x
    const results = unregisterMcpForHosts(repo, ["claude-code", "pi"], "local");
    const changed = results.filter((r) => r.changed);
    // Só um efetivamente remove (o outro é deduplicado)
    expect(changed.length).toBe(1);

    // Após unregister, chave foi removida
    const after = JSON.parse(readFileSync(path, "utf-8"));
    expect(after.mcpServers[MCP_SERVER_KEY]).toBeUndefined();
  });

  it("unregister sem scope limpa todos os escopos suportados (pi global + local)", () => {
    // Registra pi em ambos escopos
    registerMcpForHosts(repo, ["pi"], "global");
    registerMcpForHosts(repo, ["pi"], "local");

    const globalPath = join(process.env.PI_CODING_AGENT_DIR!, "mcp.json");
    const localPath = join(repo, ".mcp.json");
    expect(existsSync(globalPath)).toBe(true);
    expect(existsSync(localPath)).toBe(true);

    // Unregister sem scope → limpa ambos
    const results = unregisterMcpForHosts(repo, ["pi"]);
    const okResults = results.filter((r) => r.ok);
    expect(okResults.length).toBe(2);

    const globalConfig = JSON.parse(readFileSync(globalPath, "utf-8"));
    expect(globalConfig.mcpServers[MCP_SERVER_KEY]).toBeUndefined();

    const localConfig = JSON.parse(readFileSync(localPath, "utf-8"));
    expect(localConfig.mcpServers[MCP_SERVER_KEY]).toBeUndefined();
  });

  it("unregister sem scope limpa ambos escopos do claude-code (global + local)", () => {
    registerMcpForHosts(repo, ["claude-code"], "global");
    registerMcpForHosts(repo, ["claude-code"], "local");

    const globalPath = join(process.env.CLAUDE_CONFIG_HOME!, ".claude.json");
    const localPath = join(repo, ".mcp.json");
    expect(existsSync(globalPath)).toBe(true);
    expect(existsSync(localPath)).toBe(true);

    const results = unregisterMcpForHosts(repo, ["claude-code"]);
    const okResults = results.filter((r) => r.ok);
    expect(okResults.length).toBe(2);

    const globalConfig = readJson(globalPath);
    expect((globalConfig.mcpServers as JsonRecord)[MCP_SERVER_KEY]).toBeUndefined();

    const localConfig = readJson(localPath);
    expect((localConfig.mcpServers as JsonRecord)[MCP_SERVER_KEY]).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // ZCode adapter
  // -------------------------------------------------------------------------

  it("zcode: registra plugin no marketplace, habilita no config.json e é idempotente", () => {
    const zcodeHome = process.env.ZCODE_CONFIG_HOME!;

    const res = registerMcpForHosts(repo, ["zcode"]);
    expect(res[0].ok).toBe(true);
    expect(res[0].changed).toBe(true);

    // plugin.json criado no cache do marketplace
    const pluginJsonPath = join(
      zcodeHome,
      "cli",
      "plugins",
      "cache",
      "zcode-plugins-official",
      "argus",
      ARGUS_VERSION,
      ".zcode-plugin",
      "plugin.json",
    );
    expect(existsSync(pluginJsonPath)).toBe(true);
    const plugin = readJson(pluginJsonPath);
    expect(plugin.name).toBe("argus");
    expect(plugin.skills).toBe("./skills/");
    expect(plugin.license).toBe("MIT");
    expect(plugin.mcpServers).toBeDefined();
    const server = (plugin.mcpServers as JsonRecord)[MCP_SERVER_KEY] as JsonRecord;
    expect(server).toBeDefined();
    expect(server.transport).toBeUndefined();
    expect(server.cwd).toBe("${ZCODE_PROJECT_DIR}");

    // seed.json criado com marketplace correto
    const seedPath = join(
      zcodeHome,
      "cli",
      "plugins",
      "cache",
      "zcode-plugins-official",
      "argus",
      ARGUS_VERSION,
      ".zcode-plugin-seed.json",
    );
    expect(existsSync(seedPath)).toBe(true);
    const seed = readJson(seedPath);
    expect(seed.marketplace).toBe("zcode-plugins-official");
    expect(seed.plugin).toBe("argus");

    // skills/argus/SKILL.md criado
    const skillPath = join(
      zcodeHome,
      "cli",
      "plugins",
      "cache",
      "zcode-plugins-official",
      "argus",
      ARGUS_VERSION,
      "skills",
      "argus",
      "SKILL.md",
    );
    expect(existsSync(skillPath)).toBe(true);

    // marketplace.json com entry argus
    const mpPath = join(
      zcodeHome,
      "cli",
      "plugins",
      "marketplaces",
      "zcode-plugins-official",
      "marketplace.json",
    );
    expect(existsSync(mpPath)).toBe(true);
    const mp = readJson(mpPath);
    const mpEntry = (mp.plugins as JsonRecord[]).find((p) => p.name === "argus");
    expect(mpEntry).toBeDefined();
    expect(mpEntry!.source).toBe("filesystem");
    expect(mpEntry!.version).toBe(ARGUS_VERSION);

    // config.json habilitado com key correta
    const configPath = join(zcodeHome, "cli", "config.json");
    expect(existsSync(configPath)).toBe(true);
    const config = readJson(configPath);
    const enabled = (config.plugins as JsonRecord)?.enabledPlugins as JsonRecord;
    expect(enabled).toBeDefined();
    expect(enabled["argus@zcode-plugins-official"]).toBe(true);

    // Idempotência
    const res2 = registerMcpForHosts(repo, ["zcode"]);
    expect(res2[0].ok).toBe(true);
    expect(res2[0].changed).toBe(false);
    expect(res2[0].message).toContain("já registrado");
  });

  it("zcode: unregister remove plugin, marketplace entry e limpa config.json", () => {
    const zcodeHome = process.env.ZCODE_CONFIG_HOME!;

    registerMcpForHosts(repo, ["zcode"]);

    const configPath = join(zcodeHome, "cli", "config.json");
    const pluginVersionDir = join(
      zcodeHome,
      "cli",
      "plugins",
      "cache",
      "zcode-plugins-official",
      "argus",
      ARGUS_VERSION,
    );
    const mpPath = join(
      zcodeHome,
      "cli",
      "plugins",
      "marketplaces",
      "zcode-plugins-official",
      "marketplace.json",
    );

    expect(existsSync(configPath)).toBe(true);
    expect(existsSync(pluginVersionDir)).toBe(true);

    const results = unregisterMcpForHosts(repo, ["zcode"]);
    const changed = results.filter((r) => r.changed);
    expect(changed.length).toBeGreaterThanOrEqual(1);

    // Plugin dir removido
    expect(existsSync(pluginVersionDir)).toBe(false);

    // config.json limpo
    const config = readJson(configPath);
    const enabled = (config.plugins as JsonRecord)?.enabledPlugins as JsonRecord;
    expect(enabled?.["argus@zcode-plugins-official"]).toBeUndefined();

    // marketplace.json sem entry argus (mas arquivo preservado)
    if (existsSync(mpPath)) {
      const mp = readJson(mpPath);
      const mpEntry = (mp.plugins as JsonRecord[]).find((p) => p.name === "argus");
      expect(mpEntry).toBeUndefined();
    }
  });

  it("zcode: unregister sem plugin ainda limpa enabledPlugins do config.json", () => {
    const zcodeHome = process.env.ZCODE_CONFIG_HOME!;

    // Simula config.json com o plugin habilitado, mas sem os arquivos
    const configPath = join(zcodeHome, "cli", "config.json");
    mkdirSync(join(zcodeHome, "cli"), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({
        plugins: {
          enabledPlugins: {
            "argus@zcode-plugins-official": true,
            "outro@marketplace": true,
          },
        },
      }),
      "utf-8",
    );

    const results = unregisterMcpForHosts(repo, ["zcode"]);
    const changed = results.filter((r) => r.changed);
    expect(changed.length).toBe(1);
    expect(changed[0].message).toContain("removido do config.json");

    // Outro plugin preservado
    const config = readJson(configPath);
    const enabled = (config.plugins as JsonRecord)?.enabledPlugins as JsonRecord;
    expect(enabled?.["argus@zcode-plugins-official"]).toBeUndefined();
    expect(enabled?.["outro@marketplace"]).toBe(true);
  });

  it("zcode: register com config.json pré-existente preserva outras chaves", () => {
    const zcodeHome = process.env.ZCODE_CONFIG_HOME!;

    // Config pré-existente com outros plugins e chaves
    const configPath = join(zcodeHome, "cli", "config.json");
    mkdirSync(join(zcodeHome, "cli"), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({
        plugins: {
          enabledPlugins: {
            "outro@marketplace": true,
          },
        },
        skills: {
          "/path/to/skill": { enable: false },
        },
      }),
      "utf-8",
    );

    registerMcpForHosts(repo, ["zcode"]);

    const config = readJson(configPath);
    const enabled = (config.plugins as JsonRecord)?.enabledPlugins as JsonRecord;
    expect(enabled?.["argus@zcode-plugins-official"]).toBe(true);
    expect(enabled?.["outro@marketplace"]).toBe(true);
    // skills preservadas
    expect((config as JsonRecord).skills).toBeDefined();
  });

  it("zcode: migra instalação legacy (cache/argus/ + argus@user)", () => {
    const zcodeHome = process.env.ZCODE_CONFIG_HOME!;

    // Simula instalação legacy: cache/argus/ + argus@user no config.json
    const legacyDir = join(zcodeHome, "cli", "plugins", "cache", "argus", ARGUS_VERSION);
    mkdirSync(join(legacyDir, ".zcode-plugin"), { recursive: true });
    writeFileSync(
      join(legacyDir, ".zcode-plugin", "plugin.json"),
      JSON.stringify({
        name: "argus",
        version: ARGUS_VERSION,
        mcpServers: {
          argus: { command: "node", args: ["old"], transport: "stdio" },
        },
      }),
    );

    const configPath = join(zcodeHome, "cli", "config.json");
    mkdirSync(join(zcodeHome, "cli"), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({
        plugins: { enabledPlugins: { "argus@user": true, "other@mp": true } },
      }),
      "utf-8",
    );

    const res = registerMcpForHosts(repo, ["zcode"]);
    expect(res[0].ok).toBe(true);
    expect(res[0].changed).toBe(true);

    // Diretório legacy removido
    expect(existsSync(legacyDir)).toBe(false);

    // Enable key legacy removido, canônico adicionado
    const config = readJson(configPath);
    const enabled = (config.plugins as JsonRecord)?.enabledPlugins as JsonRecord;
    expect(enabled?.["argus@user"]).toBeUndefined();
    expect(enabled?.["argus@zcode-plugins-official"]).toBe(true);
    // Outro plugin preservado
    expect(enabled?.["other@mp"]).toBe(true);

    // Formato canônico criado
    const canonicalPath = join(
      zcodeHome,
      "cli",
      "plugins",
      "cache",
      "zcode-plugins-official",
      "argus",
      ARGUS_VERSION,
      ".zcode-plugin",
      "plugin.json",
    );
    expect(existsSync(canonicalPath)).toBe(true);
  });
});
