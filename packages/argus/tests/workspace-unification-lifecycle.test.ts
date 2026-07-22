import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  findShadowArgusState,
  resolveWorkspaceRoot,
} from "../src/workspace/resolve-workspace.js";
import {
  getMetadataPath,
  getStatePaths,
  getWorkspacePath,
  initWorkspace,
  readWorkspaceMetadata,
  type WorkspaceMetadata,
} from "../src/workspace/workspace.js";
import { runHookInstall } from "../src/commands/hooks.js";
import { runInstallRefresh, runUninstall } from "../src/commands/install.js";
import {
  registerWorkspace,
  unregisterWorkspace,
  listWorkspaceRoots,
} from "../src/daemon/registry.js";

/**
 * Plano 5 — Lifecycle: install, refresh, purge, hooks + sombra.
 * Fixture obrigatória: `.argus` em S com `root_path` stale apontando para T.
 * Prova ancorada no seam S-lifecycle sem mock de paths.
 */
describe("workspace unification — lifecycle (install/refresh/purge/hooks/sombra)", () => {
  let tempDir: string | undefined;
  let originalCwd: string | undefined;
  let savedXdg: string | undefined;
  const cleanups: string[] = [];

  beforeEach(() => {
    savedXdg = process.env.XDG_CONFIG_HOME;
  });

  afterEach(() => {
    if (originalCwd) {
      process.chdir(originalCwd);
      originalCwd = undefined;
    }
    // Limpa registry isolado
    for (const root of listWorkspaceRoots()) {
      unregisterWorkspace(root);
    }
    process.env.XDG_CONFIG_HOME = savedXdg;
    for (const dir of cleanups.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  function real(path: string): string {
    return realpathSync.native(path);
  }

  /**
   * Cria S (workspace real com git) + T (tree paralelo / root stale).
   * S tem um repositório git inicializado para testes de hooks.
   */
  function fixtureSplitWithGit(): { S: string; T: string } {
    originalCwd = process.cwd();
    tempDir = mkdtempSync(join(tmpdir(), "argus-ws-lifecycle-"));
    // Isola o registry do daemon para não tocar a máquina real.
    process.env.XDG_CONFIG_HOME = join(tempDir, "xdg-config");

    const Sraw = join(tempDir, "canonical-S");
    const Traw = join(tempDir, "stale-T");
    mkdirSync(Sraw, { recursive: true });
    mkdirSync(Traw, { recursive: true });
    const S = real(Sraw);
    const T = real(Traw);
    cleanups.push(tempDir);

    // Inicializa git em S (necessário para hooks).
    execFileSync("git", ["init"], { cwd: S, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: S, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: S, stdio: "ignore" });

    writeFileSync(join(S, "app.ts"), "export const app = 1;\n", "utf-8");
    initWorkspace(S);

    return { S, T };
  }

  function corruptRootPathTo(S: string, T: string): void {
    const meta = readWorkspaceMetadata(S);
    expect(meta).not.toBeNull();
    const stale: WorkspaceMetadata = { ...meta!, root_path: T };
    writeFileSync(getMetadataPath(S), JSON.stringify(stale, null, 2) + "\n", "utf-8");
    expect(readWorkspaceMetadata(S)?.root_path).toBe(T);
  }

  /** Cria um `.argus` sombra em T (simulando dual-write anterior). */
  function createShadowAt(T: string): void {
    initWorkspace(T);
  }

  describe("findShadowArgusState (diagnóstico D5)", () => {
    it("AC-5.2.2: detecta sombra no antigo root_path pós-heal", () => {
      const { S, T } = fixtureSplitWithGit();
      createShadowAt(T);
      corruptRootPathTo(S, T);

      // Resolve+heal: S é o canônico, T era o root_path antigo.
      const handle = resolveWorkspaceRoot(S, {}, { includeRegistry: false });
      expect(handle).not.toBeNull();
      expect(handle!.rootPath).toBe(S);
      expect(handle!.healed).toBe(true);
      expect(handle!.previousRootPath).toBe(T);

      // Diagnóstico: T tem .argus → sombra.
      const shadow = findShadowArgusState(handle!);
      expect(shadow.shadows).toContain(T);
      expect(shadow.previousRootShadow).toBe(T);
      // S não é sombra de si mesmo.
      expect(shadow.shadows).not.toContain(S);
    });

    it("AC-5.2.2: detecta sombra via registry do daemon", () => {
      const { S, T } = fixtureSplitWithGit();
      createShadowAt(T);
      // Registra T no daemon (simulando install anterior no path errado).
      registerWorkspace(T);

      // Resolve sem heal (metadata já coerente em S).
      const handle = resolveWorkspaceRoot(S, {}, { includeRegistry: false });
      expect(handle).not.toBeNull();
      expect(handle!.rootPath).toBe(S);
      expect(handle!.healed).toBeFalsy();

      // Diagnóstico com registry: T está registrado e tem .argus → sombra.
      const shadow = findShadowArgusState(handle!);
      expect(shadow.shadows).toContain(T);
    });

    it("sem sombra: retorna lista vazia quando só existe o canônico", () => {
      const { S } = fixtureSplitWithGit();
      const handle = resolveWorkspaceRoot(S, {}, { includeRegistry: false });
      expect(handle).not.toBeNull();

      const shadow = findShadowArgusState(handle!);
      expect(shadow.canonical).toBe(S);
      expect(shadow.shadows).toHaveLength(0);
      expect(shadow.previousRootShadow).toBeUndefined();
    });

    it("previousRootPath sem .argus não é reportado como sombra", () => {
      const { S, T } = fixtureSplitWithGit();
      // T existe como diretório mas sem .argus.
      corruptRootPathTo(S, T);

      const handle = resolveWorkspaceRoot(S, {}, { includeRegistry: false });
      expect(handle).not.toBeNull();
      expect(handle!.healed).toBe(true);
      expect(handle!.previousRootPath).toBe(T);

      const shadow = findShadowArgusState(handle!);
      expect(shadow.shadows).toHaveLength(0);
      expect(shadow.previousRootShadow).toBeUndefined();
    });

    it("alias do próprio estado canônico não é reportado como sombra", () => {
      const { S } = fixtureSplitWithGit();
      const alias = join(tempDir!, "alias-S");
      symlinkSync(S, alias, "dir");
      corruptRootPathTo(S, alias);

      const handle = resolveWorkspaceRoot(S, {}, { includeRegistry: false });
      expect(handle?.healed).toBe(true);
      const shadow = findShadowArgusState(handle!);
      expect(shadow.canonical).toBe(S);
      expect(shadow.shadows).toEqual([]);
    });

    it("alias canônico no registry também não é reportado como sombra", () => {
      const { S } = fixtureSplitWithGit();
      const alias = join(tempDir!, "registry-alias-S");
      symlinkSync(S, alias, "dir");
      registerWorkspace(alias);

      const handle = resolveWorkspaceRoot(S, {}, { includeRegistry: false });
      expect(findShadowArgusState(handle!).shadows).toEqual([]);
    });
  });

  describe("hooks (AC-5.2.1)", () => {
    it("AC-5.2.1: hook instalado contém cd para root healado", () => {
      const { S, T } = fixtureSplitWithGit();
      corruptRootPathTo(S, T);

      process.chdir(S);
      const code = runHookInstall(S);
      expect(code).toBe(0);

      // Heal ocorreu: metadata alinhada a S.
      expect(readWorkspaceMetadata(S)?.root_path).toBe(S);

      // Hook post-commit contém cd para S (root healado), não T.
      const hooksDir = join(S, ".git", "hooks");
      const postCommit = readFileSync(join(hooksDir, "post-commit"), "utf-8");
      expect(postCommit).toContain(`cd '${S}'`);
      expect(postCommit).not.toContain(`cd '${T}'`);

      // Todos os hooks usam o root healado.
      for (const hookName of ["post-commit", "post-merge", "post-checkout"]) {
        const content = readFileSync(join(hooksDir, hookName), "utf-8");
        expect(content).toContain(`cd '${S}'`);
        expect(content).not.toContain(T);
      }
    });

    it("hook em subdiretório resolve root via walk-up", () => {
      const { S, T } = fixtureSplitWithGit();
      corruptRootPathTo(S, T);

      // Cria subdiretório e roda hook install a partir dele.
      const sub = join(S, "packages", "app");
      mkdirSync(sub, { recursive: true });
      process.chdir(sub);

      const code = runHookInstall(sub);
      expect(code).toBe(0);

      // Hook usa S (root via walk-up + heal), não sub nem T.
      const hooksDir = join(S, ".git", "hooks");
      const postCommit = readFileSync(join(hooksDir, "post-commit"), "utf-8");
      expect(postCommit).toContain(`cd '${S}'`);
      expect(postCommit).not.toContain(`cd '${T}'`);
      expect(postCommit).not.toContain(`cd '${sub}'`);
    });
  });

  describe("purge canônico + sombra (AC-5.1.2)", () => {
    it("AC-5.1.2: runUninstall purge remove só S e lista S/T na saída", () => {
      const { S, T } = fixtureSplitWithGit();
      createShadowAt(T);
      corruptRootPathTo(S, T);
      registerWorkspace(T);
      // Mantém registry não vazio para o teste não tocar serviço global.
      registerWorkspace(join(tempDir!, "sentinel-sem-workspace"));
      process.chdir(S);
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

      const code = runUninstall({ hosts: ["claude-code"], scope: "local", purge: true });
      const output = log.mock.calls.flat().join("\n");
      log.mockRestore();

      expect(code).toBe(0);
      expect(existsSync(getWorkspacePath(S))).toBe(false);
      expect(existsSync(getWorkspacePath(T))).toBe(true);
      expect(output).toContain(`Estado canônico: ${S}`);
      expect(output).toContain(`Estado(s) sombra: ${T}`);
      expect(listWorkspaceRoots()).not.toContain(T);
    });

    it("metadata inválida falha fechado sem remover estado", () => {
      const { S } = fixtureSplitWithGit();
      writeFileSync(getMetadataPath(S), "{ inválido", "utf-8");
      process.chdir(S);
      const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

      const code = runUninstall({ hosts: ["claude-code"], scope: "local", purge: true });
      const output = error.mock.calls.flat().join("\n");
      error.mockRestore();

      expect(code).toBe(1);
      expect(output).toContain("E_WORKSPACE_INVALID");
      expect(existsSync(getWorkspacePath(S))).toBe(true);
    });
  });

  describe("refresh com heal (AC-5.1.1)", () => {
    it("AC-5.1.1/AC-5.2.2: refresh real heala e converge registry/MCP só em S", () => {
      const { S, T } = fixtureSplitWithGit();
      createShadowAt(T);
      corruptRootPathTo(S, T);
      registerWorkspace(T);
      const beforeT = readFileSync(getMetadataPath(T), "utf-8");
      process.chdir(S);

      const { code, summary } = runInstallRefresh({
        hosts: ["claude-code"],
        scope: "local",
      });

      expect(code).toBe(0);
      expect(readWorkspaceMetadata(S)?.root_path).toBe(S);
      expect(listWorkspaceRoots()).toContain(S);
      expect(listWorkspaceRoots()).not.toContain(T);
      const config = JSON.parse(readFileSync(join(S, ".mcp.json"), "utf-8"));
      expect(config.mcpServers.argus.env.ARGUS_WORKSPACE_ROOT).toBe(S);
      expect(existsSync(join(S, "AGENTS.md"))).toBe(true);
      expect(existsSync(join(T, "AGENTS.md"))).toBe(false);
      expect(readFileSync(getMetadataPath(T), "utf-8")).toBe(beforeT);
      const tFiles = readdirSync(getStatePaths(T).stateDir);
      expect(tFiles).toEqual(["workspace.json"]);
      expect(summary.messages).toContain(`Estado canônico: ${S}`);
      expect(summary.messages.join("\n")).toContain(`Estado(s) sombra: ${T}`);
    });
  });
});
