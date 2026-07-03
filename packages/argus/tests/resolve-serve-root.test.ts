import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureConfigDir, registerWorkspace, unregisterWorkspace } from "../src/daemon/registry.js";
import { initWorkspace } from "../src/workspace/workspace.js";
import {
  ARGUS_WORKSPACE_ROOT_ENV,
  resolveServeWorkspaceRoot,
} from "../src/workspace/resolve-serve-root.js";

describe("resolveServeWorkspaceRoot", () => {
  let tempDir: string;
  let savedXdgConfigHome: string | undefined;

  afterEach(() => {
    if (tempDir && existsSync(tempDir)) {
      unregisterWorkspace(tempDir);
      rmSync(tempDir, { recursive: true, force: true });
    }
    if (savedXdgConfigHome !== undefined) {
      process.env.XDG_CONFIG_HOME = savedXdgConfigHome;
    } else {
      delete process.env.XDG_CONFIG_HOME;
    }
  });

  function prepareWorkspace(dir: string): void {
    tempDir = dir;
    initWorkspace(dir);
  }

  it("resolve via ARGUS_WORKSPACE_ROOT mesmo com cwd fora do projeto", () => {
    const project = mkdtempSync(join(tmpdir(), "argus-resolve-"));
    prepareWorkspace(project);
    const outside = mkdtempSync(join(tmpdir(), "argus-outside-"));

    const root = resolveServeWorkspaceRoot(outside, {
      [ARGUS_WORKSPACE_ROOT_ENV]: project,
    });

    expect(root).toBe(project);
    rmSync(outside, { recursive: true, force: true });
  });

  it("resolve via WORKSPACE_FOLDER_PATHS (Cursor)", () => {
    const project = mkdtempSync(join(tmpdir(), "argus-resolve-"));
    prepareWorkspace(project);
    const outside = mkdtempSync(join(tmpdir(), "argus-outside-"));

    const root = resolveServeWorkspaceRoot(outside, {
      WORKSPACE_FOLDER_PATHS: project,
    });

    expect(root).toBe(project);
    rmSync(outside, { recursive: true, force: true });
  });

  it("sobe ancestrais a partir do cwd", () => {
    const project = mkdtempSync(join(tmpdir(), "argus-resolve-"));
    prepareWorkspace(project);
    const nested = join(project, "packages", "app");
    mkdirSync(nested, { recursive: true });

    const root = resolveServeWorkspaceRoot(nested, {});

    expect(root).toBe(project);
  });

  it("usa registry do daemon quando cwd não contém workspace", () => {
    const project = mkdtempSync(join(tmpdir(), "argus-resolve-"));
    prepareWorkspace(project);
    savedXdgConfigHome = process.env.XDG_CONFIG_HOME;
    const registryHome = mkdtempSync(join(tmpdir(), "argus-registry-"));
    process.env.XDG_CONFIG_HOME = registryHome;
    ensureConfigDir();
    registerWorkspace(project);

    const outside = mkdtempSync(join(tmpdir(), "argus-outside-"));
    const root = resolveServeWorkspaceRoot(outside, {});

    expect(root).toBe(project);
    rmSync(outside, { recursive: true, force: true });
    rmSync(registryHome, { recursive: true, force: true });
  });

  it("retorna null sem candidatos válidos", () => {
    const outside = mkdtempSync(join(tmpdir(), "argus-outside-"));
    tempDir = outside;
    const savedXdg = process.env.XDG_CONFIG_HOME;
    const isolatedRegistry = mkdtempSync(join(tmpdir(), "argus-empty-registry-"));
    process.env.XDG_CONFIG_HOME = isolatedRegistry;

    try {
      expect(resolveServeWorkspaceRoot(outside, {})).toBeNull();
    } finally {
      if (savedXdg !== undefined) {
        process.env.XDG_CONFIG_HOME = savedXdg;
      } else {
        delete process.env.XDG_CONFIG_HOME;
      }
      rmSync(isolatedRegistry, { recursive: true, force: true });
    }
  });
});
