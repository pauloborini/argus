import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp/server.js";
import { runIndex } from "../src/commands/index-cmd.js";
import { runSync } from "../src/commands/sync.js";
import { runMarkDirty } from "../src/commands/mark-dirty.js";
import { runAgentRulesInstall, runAgentRulesUninstall, parseAgentRulesVersion, AGENT_RULES_VERSION, BLOCK_BEGIN, buildBlock } from "../src/commands/agent-rules.js";
import {
  ARGUS_NO_INSTALL_REFRESH_ENV,
  runInstallRefresh,
} from "../src/commands/install.js";
import { MCP_SERVER_KEY } from "../src/install/mcp-hosts.js";
import { DEFAULT_LISTED_MCP_TOOLS } from "../src/mcp/tool-registry.js";
import { runHookInstall, runHookUninstall } from "../src/commands/hooks.js";
import {
  clearDirtyFlag,
  hasDirtyPaths,
  markDirty,
  readDirtyFlag,
} from "../src/discovery/dirty-flag.js";
import { gitDelta, isGitRepository, isValidGitRef } from "../src/discovery/git-delta.js";
import { loadStructuralIndexForRead } from "../src/storage/index-persistence.js";
import { initWorkspace } from "../src/workspace/workspace.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

function initGitRepo(cwd: string): void {
  git(cwd, ["init", "-q"]);
  git(cwd, ["config", "user.email", "test@example.com"]);
  git(cwd, ["config", "user.name", "Test"]);
  git(cwd, ["config", "commit.gpgsign", "false"]);
}

describe("S28 — sync de baixo atrito", () => {
  let tempDir: string | undefined;
  let originalCwd: string | undefined;

  afterEach(() => {
    if (originalCwd) {
      process.chdir(originalCwd);
      originalCwd = undefined;
    }
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  function useWorkspace(withGit = false): string {
    originalCwd = process.cwd();
    tempDir = mkdtempSync(join(tmpdir(), "argus-s28-"));
    writeFileSync(join(tempDir, "a.ts"), "export const a = 1;\n", "utf-8");
    writeFileSync(join(tempDir, "b.ts"), "export const b = 2;\n", "utf-8");
    if (withGit) {
      initGitRepo(tempDir);
      git(tempDir, ["add", "-A"]);
      git(tempDir, ["commit", "-q", "-m", "init"]);
    }
    initWorkspace(tempDir);
    process.chdir(tempDir);
    return tempDir;
  }

  describe("dirty-flag", () => {
    it("mark/read/clear é idempotente e deduplica paths", () => {
      const root = useWorkspace();
      markDirty(["x.ts", "y.ts"], { sinceRef: "HEAD~1", cwd: root });
      markDirty(["x.ts", "z.ts"], { sinceRef: "OTRO", cwd: root });
      const flag = readDirtyFlag(root);
      expect(flag?.paths).toEqual(["x.ts", "y.ts", "z.ts"]);
      // since_ref só registra na primeira marcação do ciclo.
      expect(flag?.since_ref).toBe("HEAD~1");
      expect(hasDirtyPaths(root)).toBe(true);
      clearDirtyFlag(root);
      expect(readDirtyFlag(root)).toBeNull();
      expect(hasDirtyPaths(root)).toBe(false);
    });

    it("force_full marca sujo mesmo sem paths", () => {
      const root = useWorkspace();
      markDirty([], { cwd: root, forceFull: true });
      expect(hasDirtyPaths(root)).toBe(true);
      expect(readDirtyFlag(root)?.force_full).toBe(true);
    });

    it("flag corrompida degrada para null (sem erro)", () => {
      const root = useWorkspace();
      markDirty(["x.ts"], { cwd: root });
      writeFileSync(join(root, ".argus", "dirty.json"), "{ not json", "utf-8");
      expect(readDirtyFlag(root)).toBeNull();
    });
  });

  describe("git-delta", () => {
    it("detecta repo git e valida ref", () => {
      const root = useWorkspace(true);
      expect(isGitRepository(root)).toBe(true);
      expect(isValidGitRef(root, "HEAD")).toBe(true);
      expect(isValidGitRef(root, "nope-nao-existe")).toBe(false);
    });

    it("resolve changed/removed desde um ref", () => {
      const root = useWorkspace(true);
      writeFileSync(join(root, "a.ts"), "export const a = 99;\n", "utf-8");
      writeFileSync(join(root, "c.ts"), "export const c = 3;\n", "utf-8");
      rmSync(join(root, "b.ts"));
      const delta = gitDelta(root, "HEAD");
      expect(delta).not.toBeNull();
      expect(delta?.changed.map((f) => f.relative_path).sort()).toEqual(["a.ts", "c.ts"]);
      expect(delta?.removed).toEqual(["b.ts"]);
    });

    it("retorna null sem git ou com ref inválido", () => {
      const root = useWorkspace(false);
      expect(gitDelta(root, "HEAD")).toBeNull();
      const gitRoot = useWorkspace(true);
      expect(gitDelta(gitRoot, "ref-invalido")).toBeNull();
    });
  });

  describe("sync git-delta equivale ao walk", () => {
    it("--since produz o mesmo índice estrutural que o walk completo", async () => {
      const root = useWorkspace(true);
      expect(await runIndex()).toBe(0);

      writeFileSync(join(root, "a.ts"), "export function alpha() {}\n", "utf-8");
      writeFileSync(join(root, "c.ts"), "export const c = 3;\n", "utf-8");
      rmSync(join(root, "b.ts"));

      expect(await runSync({ since: "HEAD" })).toBe(0);
      const viaGit = loadStructuralIndexForRead(root);
      const gitPaths = viaGit?.files.map((f) => f.relative_path).sort();

      // Reconciliar com walk completo: resultado idêntico.
      expect(await runSync({ full: true })).toBe(0);
      const viaWalk = loadStructuralIndexForRead(root);
      const walkPaths = viaWalk?.files.map((f) => f.relative_path).sort();

      expect(gitPaths).toEqual(["a.ts", "c.ts"]);
      expect(gitPaths).toEqual(walkPaths);
      expect(viaGit?.files.find((f) => f.relative_path === "a.ts")?.symbols[0]?.name).toBe("alpha");
    });

    it("--since cai para walk quando não há git", async () => {
      const root = useWorkspace(false);
      expect(await runIndex()).toBe(0);
      writeFileSync(join(root, "c.ts"), "export const c = 3;\n", "utf-8");
      expect(await runSync({ since: "HEAD" })).toBe(0);
      const structural = loadStructuralIndexForRead(root);
      expect(structural?.files.map((f) => f.relative_path).sort()).toEqual(["a.ts", "b.ts", "c.ts"]);
    });

    it("sync consome e limpa a dirty-flag, reportando via dirty-flag", async () => {
      const root = useWorkspace(true);
      expect(await runIndex()).toBe(0);
      writeFileSync(join(root, "c.ts"), "export const c = 3;\n", "utf-8");
      markDirty(["c.ts"], { sinceRef: "HEAD", cwd: root });
      expect(hasDirtyPaths(root)).toBe(true);

      const logs: string[] = [];
      const spy = vi.spyOn(console, "log").mockImplementation((msg) => {
        logs.push(String(msg));
      });
      expect(await runSync()).toBe(0);
      spy.mockRestore();

      expect(logs.some((l) => l.includes("via dirty-flag"))).toBe(true);
      expect(hasDirtyPaths(root)).toBe(false);
      const structural = loadStructuralIndexForRead(root);
      expect(structural?.files.map((f) => f.relative_path)).toContain("c.ts");
    });

    it("equivale ao walk respeitando .gitignore (untracked ignorado fica fora em ambos)", async () => {
      const root = useWorkspace(true);
      // .gitignore esconde local.ts: untracked + ignorado → não indexado (default).
      writeFileSync(join(root, ".gitignore"), "local.ts\n", "utf-8");
      writeFileSync(join(root, "local.ts"), "export const local = 1;\n", "utf-8");
      git(root, ["add", ".gitignore"]);
      git(root, ["commit", "-q", "-m", "gitignore"]);
      expect(await runIndex()).toBe(0);

      // local.ts é untracked + gitignored; muda junto com um tracked.
      writeFileSync(join(root, "local.ts"), "export const local = 2;\n", "utf-8");
      writeFileSync(join(root, "a.ts"), "export const a = 9;\n", "utf-8");

      expect(await runSync({ since: "HEAD" })).toBe(0);
      const viaGit = loadStructuralIndexForRead(root)
        ?.files.map((f) => f.relative_path)
        .sort();

      expect(await runSync({ full: true })).toBe(0);
      const viaWalk = loadStructuralIndexForRead(root)
        ?.files.map((f) => f.relative_path)
        .sort();

      // Default respeita .gitignore: nenhum dos caminhos indexa local.ts; sets iguais.
      expect(viaGit).not.toContain("local.ts");
      expect(viaGit).toEqual(viaWalk);
    });

    it("workspace em subdiretório de monorepo: git-delta não vaza arquivos de fora", async () => {
      // Repo git na raiz; workspace argus no subdir packages/app.
      originalCwd = process.cwd();
      tempDir = mkdtempSync(join(tmpdir(), "argus-s28-mono-"));
      const repo = tempDir;
      initGitRepo(repo);
      mkdirSync(join(repo, "packages", "app", "src"), { recursive: true });
      writeFileSync(join(repo, "root.ts"), "export const root = 0;\n", "utf-8");
      writeFileSync(join(repo, "packages", "app", "src", "a.ts"), "export const a = 1;\n", "utf-8");
      git(repo, ["add", "-A"]);
      git(repo, ["commit", "-q", "-m", "init"]);

      const ws = join(repo, "packages", "app");
      initWorkspace(ws);
      process.chdir(ws);
      expect(await runIndex()).toBe(0);

      // Muda dentro do workspace + ruído fora (root.ts).
      writeFileSync(join(ws, "src", "a.ts"), "export const a = 2;\n", "utf-8");
      writeFileSync(join(ws, "src", "b.ts"), "export const b = 3;\n", "utf-8");
      writeFileSync(join(repo, "root.ts"), "export const root = 9;\n", "utf-8");

      expect(await runSync({ since: "HEAD" })).toBe(0);
      const viaGit = loadStructuralIndexForRead(ws)
        ?.files.map((f) => f.relative_path)
        .sort();
      expect(await runSync({ full: true })).toBe(0);
      const viaWalk = loadStructuralIndexForRead(ws)
        ?.files.map((f) => f.relative_path)
        .sort();

      expect(viaGit).toEqual(["src/a.ts", "src/b.ts"]);
      expect(viaGit).toEqual(viaWalk); // root.ts (fora do workspace) não vaza
    });

    it("symlink-para-arquivo não é indexado (paridade com o walk)", async () => {
      const root = useWorkspace(true);
      expect(await runIndex()).toBe(0);
      writeFileSync(join(root, "real.ts"), "export const real = 1;\n", "utf-8");
      symlinkSync(join(root, "real.ts"), join(root, "link.ts"));

      expect(await runSync({ since: "HEAD" })).toBe(0);
      const viaGit = loadStructuralIndexForRead(root)
        ?.files.map((f) => f.relative_path)
        .sort();
      expect(await runSync({ full: true })).toBe(0);
      const viaWalk = loadStructuralIndexForRead(root)
        ?.files.map((f) => f.relative_path)
        .sort();

      expect(viaGit).toContain("real.ts");
      expect(viaGit).not.toContain("link.ts");
      expect(viaGit).toEqual(viaWalk);
    });

    it("since_ref morto cai para walk e ainda reporta consumo da dirty-flag", async () => {
      const root = useWorkspace(true);
      expect(await runIndex()).toBe(0);
      writeFileSync(join(root, "c.ts"), "export const c = 3;\n", "utf-8");
      // since_ref que não existe (simula rebase/gc).
      markDirty(["c.ts"], { sinceRef: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", cwd: root });

      const logs: string[] = [];
      const spy = vi.spyOn(console, "log").mockImplementation((m) => {
        logs.push(String(m));
      });
      expect(await runSync()).toBe(0);
      spy.mockRestore();

      expect(logs.some((l) => l.includes("via full"))).toBe(true);
      expect(logs.some((l) => l.includes("Dirty-flag consumida"))).toBe(true);
      expect(hasDirtyPaths(root)).toBe(false);
      expect(loadStructuralIndexForRead(root)?.files.map((f) => f.relative_path)).toContain("c.ts");
    });
  });

  describe("auto-sync MCP", () => {
    async function callTool(autoSync: boolean, name: string, args: Record<string, unknown>) {
      const server = createMcpServer({ autoSync });
      const client = new Client({ name: "test", version: "0" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const res = await client.callTool({ name, arguments: args });
      await client.close();
      return res;
    }

    it("consome a dirty-flag antes de servir a tool call", async () => {
      const root = useWorkspace(true);
      expect(await runIndex()).toBe(0);
      writeFileSync(join(root, "novo.ts"), "export function novaFn() {}\n", "utf-8");
      markDirty(["novo.ts"], { sinceRef: "HEAD", cwd: root });
      expect(hasDirtyPaths(root)).toBe(true);

      const res = await callTool(true, "search", { query: "novaFn" });
      const text = (res.content as Array<{ type: string; text: string }>)[0].text;

      // Auto-sync rodou: dirty-flag consumida e símbolo do arquivo novo achável.
      expect(hasDirtyPaths(root)).toBe(false);
      expect(text).toContain("novaFn");
    });

    it("Bug 9: sem daemon/hooks (dirty-flag vazia) o fallback sincroniza o drift do working tree", async () => {
      const root = useWorkspace(true);
      expect(await runIndex()).toBe(0);
      // Edição fora de daemon/hooks: a dirty-flag nunca é alimentada, então o
      // caminho quente (consumo da flag) não dispara. Só o probe de staleness
      // pega o drift.
      writeFileSync(join(root, "tardio.ts"), "export function fnTardia() {}\n", "utf-8");
      expect(hasDirtyPaths(root)).toBe(false);

      const res = await callTool(true, "search", { query: "fnTardia" });
      const text = (res.content as Array<{ type: string; text: string }>)[0].text;

      // Fallback de staleness disparou o sync mesmo sem dirty-flag: símbolo novo achável.
      expect(text).toContain("fnTardia");
    });

    it("--no-auto-sync não consome a dirty-flag", async () => {
      const root = useWorkspace(true);
      expect(await runIndex()).toBe(0);
      writeFileSync(join(root, "novo.ts"), "export const novo = 1;\n", "utf-8");
      markDirty(["novo.ts"], { sinceRef: "HEAD", cwd: root });

      await callTool(false, "status", {});
      expect(hasDirtyPaths(root)).toBe(true);
    });
  });

  describe("mark-dirty", () => {
    it("marca paths a partir do ref git", () => {
      const root = useWorkspace(true);
      writeFileSync(join(root, "c.ts"), "export const c = 3;\n", "utf-8");
      expect(runMarkDirty({ since: "HEAD" })).toBe(0);
      const flag = readDirtyFlag(root);
      expect(flag?.paths).toContain("c.ts");
      expect(flag?.since_ref).toBe("HEAD");
    });

    it("sem --since marca force_full", () => {
      const root = useWorkspace(true);
      expect(runMarkDirty({})).toBe(0);
      expect(readDirtyFlag(root)?.force_full).toBe(true);
    });
  });

  describe("agent-rules", () => {
    it("AC-2.1.1: bloco gerado recomenda path feliz alinhado ao ListTools slim", () => {
      const root = useWorkspace();
      expect(runAgentRulesInstall(root)).toBe(0);
      const claude = readFileSync(join(root, "CLAUDE.md"), "utf-8");
      expect(parseAgentRulesVersion(claude)).toBe(AGENT_RULES_VERSION);
      for (const tool of DEFAULT_LISTED_MCP_TOOLS) {
        expect(claude).toContain(`\`${tool}\``);
      }
      expect(claude).toContain("explore");
      expect(claude).toContain("pack_context");
      expect(claude).toContain("recall");
      expect(claude).toContain("status");
      expect(claude).toContain("argus explore");
      expect(claude).toContain("argus pack-context");
      expect(claude).toContain("argus memory search");
      expect(claude).toContain("antes de inventar regra");
      expect(claude).toContain("ao fechar uma decisão");
      // Path feliz ≠ menu das 12: search não é primeira recomendação operacional.
      expect(claude).toMatch(/1\.\s+`explore`/);
    });

    it("AC-2.1.2: install repetido não duplica e preserva bytes fora dos marcadores", () => {
      const root = useWorkspace();
      const marker = "USER_UNIQUE_BYTES_αβγ_§42\n";
      const prefix = `# Meu projeto\n\n${marker}Regras minhas.\n`;
      const suffix = "\n# APÓS_BLOCO_UNIQUE_ω\nnotas do usuário\n";
      // Prefixo sem bloco; 1ª install anexa. Em seguida injetamos sufixo após o
      // bloco para provar preservação byte-a-byte dos dois lados (antes/depois).
      writeFileSync(join(root, "CLAUDE.md"), prefix, "utf-8");
      expect(runAgentRulesInstall(root)).toBe(0);
      const mid = readFileSync(join(root, "CLAUDE.md"), "utf-8");
      expect(mid.startsWith(prefix)).toBe(true);
      expect(mid.split(BLOCK_BEGIN).length - 1).toBe(1);
      writeFileSync(join(root, "CLAUDE.md"), `${mid.trimEnd()}${suffix}`, "utf-8");
      const withSuffix = readFileSync(join(root, "CLAUDE.md"), "utf-8");
      expect(withSuffix.endsWith(suffix)).toBe(true);

      expect(runAgentRulesInstall(root)).toBe(0);
      const afterSecond = readFileSync(join(root, "CLAUDE.md"), "utf-8");
      expect(afterSecond).toBe(withSuffix);
      expect(afterSecond.startsWith(prefix)).toBe(true);
      expect(afterSecond.endsWith(suffix)).toBe(true);
      expect(afterSecond.split(">>> argus >>>").length - 1).toBe(1);
      expect(existsSync(join(root, "AGENTS.md"))).toBe(true);
    });

    it("AC-2.1.3: uninstall remove somente o bloco Argus", () => {
      const root = useWorkspace();
      writeFileSync(join(root, "CLAUDE.md"), "# Meu projeto\n\nRegras minhas.\n", "utf-8");
      expect(runAgentRulesInstall(root)).toBe(0);
      const content = readFileSync(join(root, "CLAUDE.md"), "utf-8");
      expect(content).toContain("# Meu projeto");
      expect(content).toContain("Regras minhas.");
      expect(content).toContain("## Argus");
      expect(runAgentRulesUninstall(root)).toBe(0);
      const after = readFileSync(join(root, "CLAUDE.md"), "utf-8");
      expect(after).toContain("# Meu projeto");
      expect(after).toContain("Regras minhas.");
      expect(after).not.toContain(">>> argus >>>");
      expect(after).not.toContain("## Argus");
    });

    it("AC-2.2.1: refresh migra versão antiga e preserva conteúdo externo", () => {
      const root = useWorkspace();
      const userPrefix = "# Prefácio do usuário\n\nBYTES_EXTERNOS_XYZ\n";
      const userSuffix = "\n# RODAPÉ_EXTERNO_ABC\n";
      const legacyBody = `## Argus\n\nMenu legado com \`search\` e \`files\`.\n`;
      const legacyBlock = `${BLOCK_BEGIN}\n${legacyBody}<!-- <<< argus <<< -->`;
      writeFileSync(join(root, "CLAUDE.md"), `${userPrefix}${legacyBlock}${userSuffix}`, "utf-8");
      writeFileSync(join(root, "AGENTS.md"), `${legacyBlock}\n`, "utf-8");
      expect(parseAgentRulesVersion(readFileSync(join(root, "CLAUDE.md"), "utf-8"))).toBeNull();

      const { code, summary } = runInstallRefresh({ noMcp: true });
      expect(code).toBe(0);
      expect(summary.optOut).toBe(false);
      const claude = readFileSync(join(root, "CLAUDE.md"), "utf-8");
      expect(claude.startsWith(userPrefix)).toBe(true);
      expect(claude.endsWith(userSuffix)).toBe(true);
      expect(claude).toContain("BYTES_EXTERNOS_XYZ");
      expect(claude).toContain("RODAPÉ_EXTERNO_ABC");
      expect(parseAgentRulesVersion(claude)).toBe(AGENT_RULES_VERSION);
      expect(claude).toContain(buildBlock());
      expect(claude.split(BLOCK_BEGIN).length - 1).toBe(1);
    });
  });

  describe("install --refresh", () => {
    it("AC-2.2.2: entrada MCP converge para path corrente e refresh repetido é no-op", () => {
      const root = useWorkspace();
      const prevClaude = process.env.CLAUDE_CONFIG_HOME;
      const prevCursor = process.env.CURSOR_CONFIG_HOME;
      process.env.CLAUDE_CONFIG_HOME = join(root, "home-claude");
      process.env.CURSOR_CONFIG_HOME = join(root, "home-cursor");

      try {
        writeFileSync(
          join(root, ".mcp.json"),
          JSON.stringify({
            mcpServers: {
              outro: { command: "keep-me", args: [] },
              [MCP_SERVER_KEY]: { command: "/stale/node", args: ["/stale/cli.js", "serve", "--mcp"] },
            },
          }) + "\n",
          "utf-8",
        );

        const first = runInstallRefresh({ hosts: ["claude-code"], scope: "local" });
        expect(first.code).toBe(0);
        expect(first.summary.skipped).toBe(false);
        const mcpPath = join(root, ".mcp.json");
        const config1 = JSON.parse(readFileSync(mcpPath, "utf-8"));
        expect(config1.mcpServers.outro).toEqual({ command: "keep-me", args: [] });
        expect(config1.mcpServers[MCP_SERVER_KEY].command).toBe(process.execPath);
        expect(config1.mcpServers[MCP_SERVER_KEY].args[0]).not.toContain("/stale/");
        expect(config1.mcpServers[MCP_SERVER_KEY].env.ARGUS_WORKSPACE_ROOT).toBe(root);

        const second = runInstallRefresh({ hosts: ["claude-code"], scope: "local" });
        expect(second.code).toBe(0);
        const rulesUnchanged = second.summary.rules?.files.every((f) => f.action === "unchanged");
        expect(rulesUnchanged).toBe(true);
        expect(second.summary.mcp?.[0].changed).toBe(false);
        expect(readFileSync(mcpPath, "utf-8")).toBe(JSON.stringify(config1, null, 2) + "\n");
      } finally {
        if (prevClaude === undefined) {
          delete process.env.CLAUDE_CONFIG_HOME;
        } else {
          process.env.CLAUDE_CONFIG_HOME = prevClaude;
        }
        if (prevCursor === undefined) {
          delete process.env.CURSOR_CONFIG_HOME;
        } else {
          process.env.CURSOR_CONFIG_HOME = prevCursor;
        }
      }
    });

    it("AC-2.2.3: opt-out impede mutação e informa ação manual", () => {
      const root = useWorkspace();
      expect(runAgentRulesInstall(root)).toBe(0);
      const before = readFileSync(join(root, "CLAUDE.md"), "utf-8");
      writeFileSync(
        join(root, "CLAUDE.md"),
        before.replace(`argus-agent-rules-version: ${AGENT_RULES_VERSION}`, "argus-agent-rules-version: 0"),
        "utf-8",
      );
      const stale = readFileSync(join(root, "CLAUDE.md"), "utf-8");
      writeFileSync(
        join(root, ".mcp.json"),
        JSON.stringify({ mcpServers: { [MCP_SERVER_KEY]: { command: "stale", args: [] } } }) + "\n",
        "utf-8",
      );
      const mcpBefore = readFileSync(join(root, ".mcp.json"), "utf-8");

      const prev = process.env[ARGUS_NO_INSTALL_REFRESH_ENV];
      process.env[ARGUS_NO_INSTALL_REFRESH_ENV] = "1";
      try {
        const { code, summary } = runInstallRefresh({ hosts: ["claude-code"], scope: "local" });
        expect(code).toBe(0);
        expect(summary.skipped).toBe(true);
        expect(summary.optOut).toBe(true);
        expect(summary.manualHint).toContain("argus install --refresh");
        expect(summary.manualHint).toContain(ARGUS_NO_INSTALL_REFRESH_ENV);
        expect(readFileSync(join(root, "CLAUDE.md"), "utf-8")).toBe(stale);
        expect(readFileSync(join(root, ".mcp.json"), "utf-8")).toBe(mcpBefore);
      } finally {
        if (prev === undefined) {
          delete process.env[ARGUS_NO_INSTALL_REFRESH_ENV];
        } else {
          process.env[ARGUS_NO_INSTALL_REFRESH_ENV] = prev;
        }
      }
    });
  });

  describe("hooks git", () => {
    it("instala hooks idempotentes preservando hook pré-existente", () => {
      const root = useWorkspace(true);
      const hookPath = join(root, ".git", "hooks", "post-commit");
      writeFileSync(hookPath, "#!/bin/sh\necho meu-hook\n", "utf-8");

      expect(runHookInstall(root)).toBe(0);
      const installed = readFileSync(hookPath, "utf-8");
      expect(installed).toContain("echo meu-hook");
      expect(installed).toContain(">>> argus >>>");
      expect(installed).toContain("mark-dirty");

      // Reinstalar não duplica o bloco.
      expect(runHookInstall(root)).toBe(0);
      const reinstalled = readFileSync(hookPath, "utf-8");
      expect(reinstalled.split(">>> argus >>>").length - 1).toBe(1);
      expect(reinstalled).toContain("echo meu-hook");

      // Uninstall remove só o bloco argus.
      expect(runHookUninstall(root)).toBe(0);
      const after = readFileSync(hookPath, "utf-8");
      expect(after).toContain("echo meu-hook");
      expect(after).not.toContain(">>> argus >>>");
    });

    it("falha com mensagem clara sem git", () => {
      const root = useWorkspace(false);
      expect(runHookInstall(root)).toBe(1);
    });
  });
});
