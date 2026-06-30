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
import { runAgentRulesInstall, runAgentRulesUninstall } from "../src/commands/agent-rules.js";
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
    it("cria CLAUDE.md/AGENTS.md e é idempotente", () => {
      const root = useWorkspace();
      expect(runAgentRulesInstall(root)).toBe(0);
      const claude1 = readFileSync(join(root, "CLAUDE.md"), "utf-8");
      expect(claude1).toContain("## Argus");
      expect(existsSync(join(root, "AGENTS.md"))).toBe(true);
      // Reinstalar não duplica o bloco.
      expect(runAgentRulesInstall(root)).toBe(0);
      const claude2 = readFileSync(join(root, "CLAUDE.md"), "utf-8");
      const occurrences = claude2.split(">>> argus >>>").length - 1;
      expect(occurrences).toBe(1);
    });

    it("preserva conteúdo pré-existente do usuário", () => {
      const root = useWorkspace();
      writeFileSync(join(root, "CLAUDE.md"), "# Meu projeto\n\nRegras minhas.\n", "utf-8");
      expect(runAgentRulesInstall(root)).toBe(0);
      const content = readFileSync(join(root, "CLAUDE.md"), "utf-8");
      expect(content).toContain("# Meu projeto");
      expect(content).toContain("Regras minhas.");
      expect(content).toContain("## Argus");
      // Uninstall remove só o bloco argus.
      expect(runAgentRulesUninstall(root)).toBe(0);
      const after = readFileSync(join(root, "CLAUDE.md"), "utf-8");
      expect(after).toContain("# Meu projeto");
      expect(after).not.toContain(">>> argus >>>");
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
