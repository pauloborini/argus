import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  registerMcpForHosts,
  unregisterMcpForHosts,
  resolveDefaultHosts,
  effectiveScope,
  MCP_SERVER_KEY,
} from "../src/install/mcp-hosts.js";

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
    repo = mkdtempSync(join(tmpdir(), "cortex-hosts-"));
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

  it("claude-code: escopo global (default) registra em settings.json e é idempotente", () => {
    const first = registerMcpForHosts(repo, ["claude-code"]);
    expect(first[0].ok).toBe(true);
    expect(first[0].changed).toBe(true);

    const path = join(process.env.CLAUDE_CONFIG_HOME!, "settings.json");
    const config = readJson(path);
    const servers = config.mcpServers as JsonRecord;
    expect(servers[MCP_SERVER_KEY]).toBeDefined();

    const second = registerMcpForHosts(repo, ["claude-code"]);
    expect(second[0].changed).toBe(false);
    expect(second[0].message).toContain("já registrado");
  });

  it("claude-code: escopo local (opt-in) registra em .mcp.json", () => {
    const res = registerMcpForHosts(repo, ["claude-code"], "local");
    expect(res[0].ok).toBe(true);
    expect(res[0].changed).toBe(true);
    expect(existsSync(join(repo, ".mcp.json"))).toBe(true);
  });

  it("claude-code: preserva outros servers e outras chaves do settings.json (merge por chave)", () => {
    const claudeDir = join(process.env.CLAUDE_CONFIG_HOME!);
    mkdirSync(claudeDir, { recursive: true });
    const path = join(claudeDir, "settings.json");
    writeFileSync(
      path,
      JSON.stringify({
        mcpServers: { outro: { command: "x", args: [] } },
        permissions: { allow: [] },
      }),
      "utf-8",
    );

    registerMcpForHosts(repo, ["claude-code"]);
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

  it("pi: escopo global escreve em PI_CODING_AGENT_DIR/mcp.json; local no repo", () => {
    const globalRes = registerMcpForHosts(repo, ["pi"], "global");
    expect(globalRes[0].ok).toBe(true);
    const globalPath = join(process.env.PI_CODING_AGENT_DIR!, "mcp.json");
    expect(existsSync(globalPath)).toBe(true);
    const servers = readJson(globalPath).mcpServers as JsonRecord;
    expect(servers[MCP_SERVER_KEY]).toBeDefined();

    const localRes = registerMcpForHosts(repo, ["pi"], "local");
    expect(localRes[0].ok).toBe(true);
    expect(existsSync(join(repo, ".mcp.json"))).toBe(true);
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

  it("cursor: escopo global (default) registra em CURSOR_CONFIG_HOME/.cursor/mcp.json e é idempotente", () => {
    const res = registerMcpForHosts(repo, ["cursor"]);
    expect(res[0].ok).toBe(true);
    expect(res[0].changed).toBe(true);

    const path = join(process.env.CURSOR_CONFIG_HOME!, ".cursor", "mcp.json");
    expect(existsSync(path)).toBe(true);
    const servers = readJson(path).mcpServers as JsonRecord;
    expect(servers[MCP_SERVER_KEY]).toBeDefined();

    const again = registerMcpForHosts(repo, ["cursor"]);
    expect(again[0].changed).toBe(false);
    expect(again[0].message).toContain("já registrado");
  });

  it("cursor: escopo local (opt-in) registra em .cursor/mcp.json do repo", () => {
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

  it("claude-code: escopo global escreve em CLAUDE_CONFIG_HOME/settings.json", () => {
    const res = registerMcpForHosts(repo, ["claude-code"], "global");
    expect(res[0].ok).toBe(true);
    expect(res[0].changed).toBe(true);
    const path = join(process.env.CLAUDE_CONFIG_HOME!, "settings.json");
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

    const globalPath = join(process.env.CLAUDE_CONFIG_HOME!, "settings.json");
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
});
