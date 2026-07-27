import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureConfigDir, registerWorkspace, unregisterWorkspace } from "../src/daemon/registry.js";
import {
  ARGUS_WORKSPACE_ROOT_ENV,
  W_WORKSPACE_ROOT_HEALED,
  requireWorkspaceRoot,
  resolveWorkspaceRoot,
} from "../src/workspace/resolve-workspace.js";
import {
  getMetadataPath,
  getStatePaths,
  initWorkspace,
  requireWorkspace,
  WORKSPACE_DIR,
} from "../src/workspace/workspace.js";

function real(path: string): string {
  return realpathSync.native(path);
}

describe("resolveWorkspaceRoot", () => {
  let tempDir: string;
  let savedXdgConfigHome: string | undefined;
  const temps: string[] = [];

  afterEach(() => {
    if (tempDir && existsSync(tempDir)) {
      unregisterWorkspace(tempDir);
      try {
        unregisterWorkspace(real(tempDir));
      } catch {
        /* ignore */
      }
      rmSync(tempDir, { recursive: true, force: true });
    }
    for (const dir of temps.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
    if (savedXdgConfigHome !== undefined) {
      process.env.XDG_CONFIG_HOME = savedXdgConfigHome;
    } else {
      delete process.env.XDG_CONFIG_HOME;
    }
  });

  function track(dir: string): string {
    temps.push(dir);
    return dir;
  }

  it("AC-1.1.1: heal reescreve root_path stale para realpath(S)", () => {
    const stateParent = track(mkdtempSync(join(tmpdir(), "argus-heal-s-")));
    const staleRoot = track(mkdtempSync(join(tmpdir(), "argus-heal-t-")));
    initWorkspace(stateParent);

    const metaPath = getMetadataPath(stateParent);
    const raw = JSON.parse(readFileSync(metaPath, "utf-8")) as Record<string, unknown>;
    raw.root_path = staleRoot;
    writeFileSync(metaPath, JSON.stringify(raw, null, 2) + "\n", "utf-8");

    const handle = resolveWorkspaceRoot(stateParent, {});

    expect(handle).not.toBeNull();
    expect(handle!.rootPath).toBe(real(stateParent));
    expect(handle!.metadata.root_path).toBe(real(stateParent));
    expect(handle!.healed).toBe(true);
    expect(handle!.healWarning).toBe(W_WORKSPACE_ROOT_HEALED);
    expect(handle!.stateDir).toBe(join(real(stateParent), WORKSPACE_DIR));

    const persisted = JSON.parse(readFileSync(metaPath, "utf-8")) as { root_path: string };
    expect(persisted.root_path).toBe(real(stateParent));
    // D5: path antigo não é apagado automaticamente
    expect(existsSync(staleRoot)).toBe(true);
  });

  it("AC-1.1.1: alias do mesmo root também gera heal e warning D4", () => {
    const stateParent = track(mkdtempSync(join(tmpdir(), "argus-heal-real-")));
    const aliasParent = track(`${stateParent}-alias`);
    symlinkSync(stateParent, aliasParent, "dir");
    initWorkspace(stateParent);

    const metaPath = getMetadataPath(stateParent);
    const raw = JSON.parse(readFileSync(metaPath, "utf-8")) as Record<string, unknown>;
    raw.root_path = aliasParent;
    writeFileSync(metaPath, JSON.stringify(raw, null, 2) + "\n", "utf-8");

    const handle = resolveWorkspaceRoot(stateParent, {});

    expect(handle?.rootPath).toBe(real(stateParent));
    expect(handle?.metadata.root_path).toBe(real(stateParent));
    expect(handle?.healed).toBe(true);
    expect(handle?.healWarning).toBe(W_WORKSPACE_ROOT_HEALED);
  });

  it("metadata corrompida falha alto sem fallback silencioso", () => {
    const invalid = track(mkdtempSync(join(tmpdir(), "argus-invalid-")));
    const fallback = track(mkdtempSync(join(tmpdir(), "argus-fallback-")));
    mkdirSync(join(invalid, WORKSPACE_DIR), { recursive: true });
    writeFileSync(getMetadataPath(invalid), JSON.stringify({ root_path: invalid }), "utf-8");
    initWorkspace(fallback);

    expect(() =>
      resolveWorkspaceRoot(fallback, { [ARGUS_WORKSPACE_ROOT_ENV]: invalid }),
    ).toThrow(/E_WORKSPACE_INVALID/);
  });

  it("AC-1.1.2: ARGUS_WORKSPACE_ROOT vence walk-up", () => {
    const project = track(mkdtempSync(join(tmpdir(), "argus-env-")));
    initWorkspace(project);
    const nestedOther = track(mkdtempSync(join(tmpdir(), "argus-other-")));
    initWorkspace(nestedOther);
    const nested = join(nestedOther, "packages", "app");
    mkdirSync(nested, { recursive: true });

    const handle = resolveWorkspaceRoot(nested, {
      [ARGUS_WORKSPACE_ROOT_ENV]: project,
    });

    expect(handle).not.toBeNull();
    expect(handle!.rootPath).toBe(real(project));
  });

  it("sobe ancestrais a partir do cwd", () => {
    const project = track(mkdtempSync(join(tmpdir(), "argus-walk-")));
    tempDir = project;
    initWorkspace(project);
    const nested = join(project, "packages", "app");
    mkdirSync(nested, { recursive: true });

    const handle = resolveWorkspaceRoot(nested, {});

    expect(handle).not.toBeNull();
    expect(handle!.rootPath).toBe(real(project));
    expect(handle!.metadata.root_path).toBe(real(project));
    expect(handle!.healed).toBe(project === real(project) ? undefined : true);
  });

  it("usa registry do daemon quando cwd não contém workspace", () => {
    const project = track(mkdtempSync(join(tmpdir(), "argus-reg-")));
    tempDir = project;
    initWorkspace(project);
    savedXdgConfigHome = process.env.XDG_CONFIG_HOME;
    const registryHome = track(mkdtempSync(join(tmpdir(), "argus-registry-")));
    process.env.XDG_CONFIG_HOME = registryHome;
    ensureConfigDir();
    registerWorkspace(project);

    const outside = track(mkdtempSync(join(tmpdir(), "argus-outside-")));
    const handle = resolveWorkspaceRoot(outside, {});

    expect(handle).not.toBeNull();
    expect(handle!.rootPath).toBe(real(project));
  });

  it("retorna null sem candidatos válidos", () => {
    const outside = track(mkdtempSync(join(tmpdir(), "argus-empty-")));
    savedXdgConfigHome = process.env.XDG_CONFIG_HOME;
    const isolatedRegistry = track(mkdtempSync(join(tmpdir(), "argus-empty-registry-")));
    process.env.XDG_CONFIG_HOME = isolatedRegistry;

    expect(resolveWorkspaceRoot(outside, {})).toBeNull();
  });
});

describe("getStatePaths", () => {
  it("AC-1.2.1: todos os paths são filhos de rootPath/.argus", () => {
    const root = "/tmp/argus-state-paths-root";
    const paths = getStatePaths(root);
    const prefix = join(root, WORKSPACE_DIR);

    expect(paths.stateDir).toBe(prefix);
    for (const value of [
      paths.metadata,
      paths.manifest,
      paths.structuralIndex,
      paths.indexDb,
      paths.dirtyFlag,
      paths.syncLock,
      paths.memoryDir,
      paths.memoryDb,
      paths.packedHandlesDir,
    ]) {
      expect(value.startsWith(prefix + "/") || value === prefix).toBe(true);
    }
    expect(paths.syncLock).toMatch(/\.argus\/sync\.lock$/);
    expect(paths.packedHandlesDir).toMatch(/\.argus\/packed-handles$/);
    expect(paths.memoryDb).toMatch(/\.argus\/memory\/memory\.db$/);
  });
});

describe("requireWorkspace (walk-up + heal — Plano 4)", () => {
  const temps: string[] = [];
  let savedXdgConfigHome: string | undefined;

  afterEach(() => {
    for (const dir of temps.splice(0)) {
      try {
        unregisterWorkspace(dir);
        unregisterWorkspace(real(dir));
      } catch {
        /* ignore */
      }
      rmSync(dir, { recursive: true, force: true });
    }
    if (savedXdgConfigHome !== undefined) {
      process.env.XDG_CONFIG_HOME = savedXdgConfigHome;
    } else {
      delete process.env.XDG_CONFIG_HOME;
    }
  });

  function track(dir: string): string {
    temps.push(dir);
    return dir;
  }

  it("AC-4.1.1: subdiretório sem .argus resolve para raiz com .argus via walk-up", () => {
    const repo = track(mkdtempSync(join(tmpdir(), "argus-cli-walk-")));
    initWorkspace(repo);
    const nested = join(repo, "packages", "x");
    mkdirSync(nested, { recursive: true });

    // requireWorkspace a partir do subdiretório deve achar o .argus na raiz
    const metadata = requireWorkspace(nested);

    expect(metadata.root_path).toBe(real(repo));
  });

  it("AC-4.1.1: heal é aplicado quando metadata no subdiretório tem root_path stale", () => {
    const repo = track(mkdtempSync(join(tmpdir(), "argus-cli-heal-")));
    const staleRoot = track(mkdtempSync(join(tmpdir(), "argus-cli-stale-")));
    initWorkspace(repo);

    // Corrompe root_path para valor stale
    const metaPath = getMetadataPath(repo);
    const raw = JSON.parse(readFileSync(metaPath, "utf-8")) as Record<string, unknown>;
    raw.root_path = staleRoot;
    writeFileSync(metaPath, JSON.stringify(raw, null, 2) + "\n", "utf-8");

    const nested = join(repo, "src", "deep");
    mkdirSync(nested, { recursive: true });

    // Walk-up acha .argus em repo, heal corrige root_path
    const metadata = requireWorkspace(nested);

    expect(metadata.root_path).toBe(real(repo));
    // Metadata persistida foi healada
    const persisted = JSON.parse(readFileSync(metaPath, "utf-8")) as { root_path: string };
    expect(persisted.root_path).toBe(real(repo));
  });

  it("AC-4.1.2: sem .argus em ancestrais lança E_WORKSPACE_INVALID", () => {
    const outside = track(mkdtempSync(join(tmpdir(), "argus-cli-nows-")));
    savedXdgConfigHome = process.env.XDG_CONFIG_HOME;
    const isolatedRegistry = track(mkdtempSync(join(tmpdir(), "argus-cli-reg-")));
    process.env.XDG_CONFIG_HOME = isolatedRegistry;
    ensureConfigDir();

    expect(() => requireWorkspace(outside)).toThrow(/E_WORKSPACE_INVALID/);
  });

  it("monorepo: .argus em packages/app não resolve para git root sem .argus", () => {
    const repo = track(mkdtempSync(join(tmpdir(), "argus-mono-")));
    // Sem .argus na raiz do repo
    const pkg = join(repo, "packages", "app");
    mkdirSync(pkg, { recursive: true });
    initWorkspace(pkg);

    const nested = join(pkg, "src");
    mkdirSync(nested, { recursive: true });

    // Walk-up deve parar em packages/app (primeiro .argus), não na raiz
    const metadata = requireWorkspace(nested);
    expect(metadata.root_path).toBe(real(pkg));
  });

  it("caminho rápido: metadata diretamente em startCwd sem walk-up", () => {
    const repo = track(mkdtempSync(join(tmpdir(), "argus-cli-direct-")));
    initWorkspace(repo);

    const metadata = requireWorkspace(repo);
    expect(metadata.root_path).toBe(real(repo));
  });

  it("D6: requireWorkspace preserva prioridade da env sobre workspace local", () => {
    const local = track(mkdtempSync(join(tmpdir(), "argus-cli-local-")));
    const explicit = track(mkdtempSync(join(tmpdir(), "argus-cli-explicit-")));
    initWorkspace(local);
    initWorkspace(explicit);

    const previous = process.env[ARGUS_WORKSPACE_ROOT_ENV];
    process.env[ARGUS_WORKSPACE_ROOT_ENV] = explicit;
    try {
      expect(requireWorkspace(local).root_path).toBe(real(explicit));
    } finally {
      if (previous === undefined) {
        delete process.env[ARGUS_WORKSPACE_ROOT_ENV];
      } else {
        process.env[ARGUS_WORKSPACE_ROOT_ENV] = previous;
      }
    }
  });
});

describe("requireWorkspaceRoot (Plano 4)", () => {
  const temps: string[] = [];

  afterEach(() => {
    for (const dir of temps.splice(0)) {
      try {
        unregisterWorkspace(dir);
        unregisterWorkspace(real(dir));
      } catch {
        /* ignore */
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function track(dir: string): string {
    temps.push(dir);
    return dir;
  }

  it("retorna WorkspaceHandle com rootPath healado", () => {
    const repo = track(mkdtempSync(join(tmpdir(), "argus-reqroot-")));
    initWorkspace(repo);
    const nested = join(repo, "sub");
    mkdirSync(nested, { recursive: true });

    const handle = requireWorkspaceRoot(nested, {});

    expect(handle.rootPath).toBe(real(repo));
    expect(handle.metadata.root_path).toBe(real(repo));
    expect(handle.stateDir).toBe(join(real(repo), WORKSPACE_DIR));
  });

  it("lança E_WORKSPACE_INVALID sem workspace", () => {
    const outside = track(mkdtempSync(join(tmpdir(), "argus-reqroot-nows-")));
    const savedXdg = process.env.XDG_CONFIG_HOME;
    const isolatedRegistry = track(mkdtempSync(join(tmpdir(), "argus-reqroot-reg-")));
    process.env.XDG_CONFIG_HOME = isolatedRegistry;
    ensureConfigDir();

    try {
      expect(() => requireWorkspaceRoot(outside, {})).toThrow(/E_WORKSPACE_INVALID/);
    } finally {
      if (savedXdg !== undefined) {
        process.env.XDG_CONFIG_HOME = savedXdg;
      } else {
        delete process.env.XDG_CONFIG_HOME;
      }
    }
  });
});

describe("AC-4.2.1: resolveServeWorkspaceRoot ≡ resolveWorkspaceRoot", () => {
  const temps: string[] = [];
  let savedXdgConfigHome: string | undefined;

  afterEach(() => {
    for (const dir of temps.splice(0)) {
      try {
        unregisterWorkspace(dir);
        unregisterWorkspace(real(dir));
      } catch {
        /* ignore */
      }
      rmSync(dir, { recursive: true, force: true });
    }
    if (savedXdgConfigHome !== undefined) {
      process.env.XDG_CONFIG_HOME = savedXdgConfigHome;
    } else {
      delete process.env.XDG_CONFIG_HOME;
    }
  });

  function track(dir: string): string {
    temps.push(dir);
    return dir;
  }

  it("walk-up: ambos concordam no root resolvido", async () => {
    const { resolveServeWorkspaceRoot } = await import(
      "../src/workspace/resolve-serve-root.js"
    );

    const repo = track(mkdtempSync(join(tmpdir(), "argus-parity-")));
    initWorkspace(repo);
    const nested = join(repo, "packages", "app");
    mkdirSync(nested, { recursive: true });

    const serveRoot = resolveServeWorkspaceRoot(nested, {});
    const handle = resolveWorkspaceRoot(nested, {});

    expect(serveRoot).toBe(handle!.rootPath);
    expect(serveRoot).toBe(real(repo));
  });

  it("heal: ambos aplicam heal D4 e concordam", async () => {
    const { resolveServeWorkspaceRoot } = await import(
      "../src/workspace/resolve-serve-root.js"
    );

    // Fixture separada para cada chamada: heal é idempotente, mas a primeira
    // chamada reescreve metadata e a segunda já encontra healada.
    const repo1 = track(mkdtempSync(join(tmpdir(), "argus-parity-heal1-")));
    const stale1 = track(mkdtempSync(join(tmpdir(), "argus-parity-stale1-")));
    initWorkspace(repo1);
    const meta1 = getMetadataPath(repo1);
    const raw1 = JSON.parse(readFileSync(meta1, "utf-8")) as Record<string, unknown>;
    raw1.root_path = stale1;
    writeFileSync(meta1, JSON.stringify(raw1, null, 2) + "\n", "utf-8");

    const repo2 = track(mkdtempSync(join(tmpdir(), "argus-parity-heal2-")));
    const stale2 = track(mkdtempSync(join(tmpdir(), "argus-parity-stale2-")));
    initWorkspace(repo2);
    const meta2 = getMetadataPath(repo2);
    const raw2 = JSON.parse(readFileSync(meta2, "utf-8")) as Record<string, unknown>;
    raw2.root_path = stale2;
    writeFileSync(meta2, JSON.stringify(raw2, null, 2) + "\n", "utf-8");

    const serveRoot = resolveServeWorkspaceRoot(repo1, {});
    const handle = resolveWorkspaceRoot(repo2, {});

    // Ambos curam para o realpath do diretório que contém .argus
    expect(serveRoot).toBe(real(repo1));
    expect(handle!.rootPath).toBe(real(repo2));
    expect(handle!.healed).toBe(true);
  });

  it("env: ambos respeitam ARGUS_WORKSPACE_ROOT com prioridade", async () => {
    const { resolveServeWorkspaceRoot } = await import(
      "../src/workspace/resolve-serve-root.js"
    );

    const project = track(mkdtempSync(join(tmpdir(), "argus-parity-env-")));
    initWorkspace(project);
    const other = track(mkdtempSync(join(tmpdir(), "argus-parity-other-")));
    initWorkspace(other);
    const nested = join(other, "sub");
    mkdirSync(nested, { recursive: true });

    const env = { [ARGUS_WORKSPACE_ROOT_ENV]: project };
    const serveRoot = resolveServeWorkspaceRoot(nested, env);
    const handle = resolveWorkspaceRoot(nested, env);

    expect(serveRoot).toBe(handle!.rootPath);
    expect(serveRoot).toBe(real(project));
  });
});
