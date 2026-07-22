import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getMetadataPath,
  initWorkspace,
  readWorkspaceMetadata,
  requireWorkspace,
  workspaceExists,
  PRODUCT_ID,
} from "../src/workspace/workspace.js";

describe("workspace", () => {
  let tempDir: string;
  let savedXdg: string | undefined;
  let isolatedRegistry: string | undefined;

  afterEach(() => {
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
    if (savedXdg !== undefined) {
      process.env.XDG_CONFIG_HOME = savedXdg;
    } else if (isolatedRegistry) {
      delete process.env.XDG_CONFIG_HOME;
    }
    if (isolatedRegistry) {
      rmSync(isolatedRegistry, { recursive: true, force: true });
      isolatedRegistry = undefined;
    }
    savedXdg = undefined;
  });

  it("init cria metadados em .argus/", () => {
    tempDir = mkdtempSync(join(tmpdir(), "argus-ws-"));
    const result = initWorkspace(tempDir);

    expect(result.ok).toBe(true);
    expect(result.created).toBe(true);
    expect(existsSync(getMetadataPath(tempDir))).toBe(true);

    const metadata = readWorkspaceMetadata(tempDir);
    expect(metadata?.product_id).toBe(PRODUCT_ID);
    expect(metadata?.schema_version).toBeTruthy();
    expect(metadata?.initialized_at).toBeTruthy();
  });

  it("segunda execução de init é idempotente", () => {
    tempDir = mkdtempSync(join(tmpdir(), "argus-ws-"));
    initWorkspace(tempDir);
    const second = initWorkspace(tempDir);

    expect(second.ok).toBe(true);
    expect(second.created).toBe(false);
    expect(second.message).toContain("já preparado");
  });

  it("requireWorkspace falha sem init", () => {
    tempDir = mkdtempSync(join(tmpdir(), "argus-ws-"));
    // Isola registry para que walk-up não ache workspaces reais do daemon.
    savedXdg = process.env.XDG_CONFIG_HOME;
    isolatedRegistry = mkdtempSync(join(tmpdir(), "argus-ws-reg-"));
    process.env.XDG_CONFIG_HOME = isolatedRegistry;

    expect(workspaceExists(tempDir)).toBe(false);
    expect(() => requireWorkspace(tempDir)).toThrow(/E_WORKSPACE_INVALID/);
  });

  it("init falha com workspace.json corrompido", () => {
    tempDir = mkdtempSync(join(tmpdir(), "argus-ws-"));
    mkdirSync(join(tempDir, ".argus"));
    writeFileSync(getMetadataPath(tempDir), "{ invalid json", "utf-8");

    const result = initWorkspace(tempDir);

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/corrompidos/);
  });
});
