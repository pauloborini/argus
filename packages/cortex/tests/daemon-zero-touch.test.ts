import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildExplicitDelta } from "../src/discovery/explicit-delta.js";
import { withSyncLock } from "../src/concurrency/sync-lock.js";
import { runIndex } from "../src/commands/index-cmd.js";
import { runSync } from "../src/commands/sync.js";
import { initWorkspace } from "../src/workspace/workspace.js";
import { loadStructuralIndexForRead } from "../src/storage/index-persistence.js";
import {
  listWorkspaceRoots,
  readRegistry,
  registerWorkspace,
  unregisterWorkspace,
} from "../src/daemon/registry.js";
import {
  MCP_SERVER_KEY,
  registerMcpForHosts,
  unregisterMcpForHosts,
} from "../src/install/mcp-hosts.js";
import { WorkspacePipeline } from "../src/daemon/pipeline.js";
import { markDirty, readDirtyFlag } from "../src/discovery/dirty-flag.js";
import { runInstall } from "../src/commands/install.js";
import { acquireDaemonLock } from "../src/daemon/lock.js";

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: ["ignore", "ignore", "ignore"] });
}

function initGitRepo(cwd: string): void {
  git(cwd, ["init", "-q"]);
  git(cwd, ["config", "user.email", "test@example.com"]);
  git(cwd, ["config", "user.name", "Test"]);
  git(cwd, ["config", "commit.gpgsign", "false"]);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("S30 — daemon de auto-sync + instalação zero-toque", () => {
  let tempDir: string | undefined;
  let originalCwd: string | undefined;
  let originalXdgConfig: string | undefined;
  let originalXdgState: string | undefined;

  beforeEach(() => {
    originalXdgConfig = process.env.XDG_CONFIG_HOME;
    originalXdgState = process.env.XDG_STATE_HOME;
  });

  afterEach(() => {
    if (originalCwd) {
      process.chdir(originalCwd);
      originalCwd = undefined;
    }
    if (originalXdgConfig === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalXdgConfig;
    }
    if (originalXdgState === undefined) {
      delete process.env.XDG_STATE_HOME;
    } else {
      process.env.XDG_STATE_HOME = originalXdgState;
    }
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  function makeRepo(): string {
    tempDir = mkdtempSync(join(tmpdir(), "cortex-s30-"));
    return tempDir;
  }

  describe("buildExplicitDelta", () => {
    it("classifica criados/modificados como changed e ausentes como removed", () => {
      const root = makeRepo();
      writeFileSync(join(root, "a.ts"), "export const a = 1;\n");

      const delta = buildExplicitDelta(root, [
        join(root, "a.ts"),
        join(root, "sumiu.ts"),
      ]);

      expect(delta.changed.map((f) => f.relative_path)).toEqual(["a.ts"]);
      expect(delta.removed).toEqual(["sumiu.ts"]);
    });

    it("respeita .gitignore (arquivo ignorado não vira changed)", () => {
      const root = makeRepo();
      initGitRepo(root);
      writeFileSync(join(root, ".gitignore"), "ignored.ts\n");
      writeFileSync(join(root, "ignored.ts"), "export const x = 1;\n");
      writeFileSync(join(root, "kept.ts"), "export const y = 2;\n");

      const delta = buildExplicitDelta(root, [
        join(root, "ignored.ts"),
        join(root, "kept.ts"),
      ]);

      expect(delta.changed.map((f) => f.relative_path)).toEqual(["kept.ts"]);
    });

    it("descarta symlink e path fora da raiz", () => {
      const root = makeRepo();
      writeFileSync(join(root, "real.ts"), "export const a = 1;\n");
      symlinkSync(join(root, "real.ts"), join(root, "link.ts"));

      const delta = buildExplicitDelta(root, [
        join(root, "link.ts"),
        "/etc/hosts",
        join(root, "real.ts"),
      ]);

      const paths = delta.changed.map((f) => f.relative_path);
      expect(paths).toContain("real.ts");
      expect(paths).not.toContain("link.ts");
      expect(paths.every((p) => !p.startsWith("../"))).toBe(true);
    });
  });

  describe("sync via paths explícitos (hot path do daemon)", () => {
    it("reflete edição no índice sem walk, marcando synced_via=watch", async () => {
      const root = makeRepo();
      originalCwd = process.cwd();
      process.chdir(root);
      initWorkspace(root);
      writeFileSync(join(root, "mod.ts"), "export function alpha() {}\n");
      expect(await runIndex()).toBe(0);

      // Edita adicionando um símbolo novo e sincroniza só por path explícito.
      writeFileSync(join(root, "mod.ts"), "export function alpha() {}\nexport function beta() {}\n");
      const code = await runSync({ cwd: root, paths: [join(root, "mod.ts")] });
      expect(code).toBe(0);

      const index = loadStructuralIndexForRead(root);
      const symbols = index?.files
        .find((f) => f.relative_path === "mod.ts")
        ?.symbols.map((s) => s.name);
      expect(symbols).toContain("beta");
    });

    it("não limpa dirty-flag pendente quando sync veio do watcher", async () => {
      const root = makeRepo();
      originalCwd = process.cwd();
      process.chdir(root);
      initWorkspace(root);
      writeFileSync(join(root, "watched.ts"), "export const watched = 1;\n");
      expect(await runIndex()).toBe(0);

      markDirty(["git-only.ts"], { cwd: root, forceFull: true });
      writeFileSync(join(root, "watched.ts"), "export const watched = 2;\n");

      const code = await runSync({ cwd: root, paths: [join(root, "watched.ts")] });
      expect(code).toBe(0);

      const dirty = readDirtyFlag(root);
      expect(dirty?.force_full).toBe(true);
      expect(dirty?.paths).toContain("git-only.ts");
    });

    it("preserva paths do watcher na dirty-flag quando o lock está ocupado", async () => {
      const root = makeRepo();
      originalCwd = process.cwd();
      process.chdir(root);
      initWorkspace(root);
      writeFileSync(join(root, "locked.ts"), "export const locked = 1;\n");
      expect(await runIndex()).toBe(0);

      let release: () => void = () => {};
      const held = new Promise<void>((r) => {
        release = r;
      });
      const first = withSyncLock(root, async () => {
        await held;
      });
      await sleep(20);

      const code = await runSync({
        cwd: root,
        paths: [join(root, "locked.ts")],
        lockTimeoutMs: 50,
      });
      expect(code).toBe(0);
      expect(readDirtyFlag(root)?.paths).toContain("locked.ts");

      release();
      await first;
    });
  });

  describe("withSyncLock", () => {
    it("serializa: segundo acquire concorrente não roda dentro do timeout", async () => {
      const root = makeRepo();
      initWorkspace(root);

      let release: () => void = () => {};
      const held = new Promise<void>((r) => {
        release = r;
      });

      const first = withSyncLock(root, async () => {
        await held;
        return "first";
      });
      // Dá tempo do primeiro pegar o lock.
      await sleep(20);
      const second = await withSyncLock(root, async () => "second", 100);
      expect(second.acquired).toBe(false);

      release();
      const firstResult = await first;
      expect(firstResult.acquired).toBe(true);
      expect(firstResult.result).toBe("first");
    });

    it("rouba lock órfão de processo morto", async () => {
      const root = makeRepo();
      initWorkspace(root);
      // Escreve um lock de um pid impossível (morto).
      const lockFile = join(root, ".cortex", "sync.lock");
      writeFileSync(lockFile, JSON.stringify({ pid: 2 ** 30, acquired_at: Date.now() }));

      const res = await withSyncLock(root, async () => "ok", 2000);
      expect(res.acquired).toBe(true);
      expect(res.result).toBe("ok");
    });

    it("não rouba lock vazio recém-criado", async () => {
      const root = makeRepo();
      initWorkspace(root);
      const lockFile = join(root, ".cortex", "sync.lock");
      writeFileSync(lockFile, "");

      const res = await withSyncLock(root, async () => "bad", 100);
      expect(res.acquired).toBe(false);
      expect(readFileSync(lockFile, "utf-8")).toBe("");
    });
  });

  describe("daemon global lock", () => {
    it("impede duas instâncias simultâneas do daemon", () => {
      const root = makeRepo();
      process.env.XDG_STATE_HOME = join(root, "state");

      const first = acquireDaemonLock(50);
      expect(first).not.toBeNull();
      const second = acquireDaemonLock(50);
      expect(second).toBeNull();

      first?.();
      const third = acquireDaemonLock(50);
      expect(third).not.toBeNull();
      third?.();
    });
  });

  describe("registry", () => {
    it("registra/desregistra de forma idempotente", () => {
      const root = makeRepo();
      process.env.XDG_CONFIG_HOME = join(root, "xdg");

      expect(registerWorkspace(root)).toBe(true);
      expect(registerWorkspace(root)).toBe(false); // idempotente
      expect(listWorkspaceRoots()).toContain(root);
      expect(readRegistry().workspaces).toHaveLength(1);

      expect(unregisterWorkspace(root)).toBe(true);
      expect(unregisterWorkspace(root)).toBe(false);
      expect(listWorkspaceRoots()).not.toContain(root);
    });
  });

  describe("mcp-hosts", () => {
    it("registra idempotente e preserva servers de terceiros", () => {
      const root = makeRepo();
      // Pré-existe um server do usuário no .mcp.json do Claude Code.
      writeFileSync(
        join(root, ".mcp.json"),
        JSON.stringify({ mcpServers: { outro: { command: "x", args: [] } } }, null, 2),
      );

      const first = registerMcpForHosts(root, ["claude-code"], "local");
      expect(first[0].ok).toBe(true);
      expect(first[0].changed).toBe(true);

      const config = JSON.parse(readFileSync(join(root, ".mcp.json"), "utf-8"));
      expect(config.mcpServers.outro).toBeDefined();
      expect(config.mcpServers[MCP_SERVER_KEY]).toBeDefined();

      // Idempotente: segunda chamada não muda nada.
      const second = registerMcpForHosts(root, ["claude-code"], "local");
      expect(second[0].changed).toBe(false);

      // Cursor escreve em .cursor/mcp.json.
      registerMcpForHosts(root, ["cursor"], "local");
      expect(existsSync(join(root, ".cursor", "mcp.json"))).toBe(true);

      // Unregister remove só a chave do Cortex.
      const un = unregisterMcpForHosts(root, ["claude-code"], "local");
      expect(un[0].changed).toBe(true);
      const after = JSON.parse(readFileSync(join(root, ".mcp.json"), "utf-8"));
      expect(after.mcpServers.outro).toBeDefined();
      expect(after.mcpServers[MCP_SERVER_KEY]).toBeUndefined();
    });
  });

  describe("install", () => {
    it("retorna falha parcial quando MCP não pôde ser registrado", async () => {
      const root = makeRepo();
      originalCwd = process.cwd();
      process.chdir(root);
      process.env.XDG_CONFIG_HOME = join(root, "xdg");
      writeFileSync(join(root, "sample.ts"), "export const sample = 1;\n");
      writeFileSync(join(root, ".mcp.json"), "{ json inválido");

      const code = await runInstall({ hosts: ["claude-code"], scope: "local", noDaemon: true });
      expect(code).toBe(1);
    });
  });

  describe("WorkspacePipeline", () => {
    it("coalesce rajada de eventos em um único sync (debounce)", async () => {
      const root = makeRepo();
      originalCwd = process.cwd();
      process.chdir(root);
      initWorkspace(root);
      writeFileSync(join(root, "one.ts"), "export const one = 1;\n");
      writeFileSync(join(root, "two.ts"), "export const two = 2;\n");
      await runIndex();

      let syncCount = 0;
      let lastPaths = 0;
      const pipeline = new WorkspacePipeline(root, 60, {
        onSync: (info) => {
          syncCount += 1;
          lastPaths = info.paths;
        },
      });

      // Rajada: dois enqueues separados dentro da janela de debounce.
      pipeline.enqueue([join(root, "one.ts")]);
      await sleep(10);
      pipeline.enqueue([join(root, "two.ts")]);

      await sleep(200);
      pipeline.dispose();

      expect(syncCount).toBe(1);
      expect(lastPaths).toBe(2);
    });
  });
});
