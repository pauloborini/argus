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
  resolveWorkspaceRoot,
} from "../src/workspace/resolve-workspace.js";
import {
  getMetadataPath,
  getStatePaths,
  initWorkspace,
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
