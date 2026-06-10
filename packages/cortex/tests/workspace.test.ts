import { existsSync, mkdtempSync, rmSync } from "node:fs";
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

  afterEach(() => {
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("init cria metadados em .cortex/", () => {
    tempDir = mkdtempSync(join(tmpdir(), "cortex-ws-"));
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
    tempDir = mkdtempSync(join(tmpdir(), "cortex-ws-"));
    initWorkspace(tempDir);
    const second = initWorkspace(tempDir);

    expect(second.ok).toBe(true);
    expect(second.created).toBe(false);
    expect(second.message).toContain("já preparado");
  });

  it("requireWorkspace falha sem init", () => {
    tempDir = mkdtempSync(join(tmpdir(), "cortex-ws-"));
    expect(workspaceExists(tempDir)).toBe(false);
    expect(() => requireWorkspace(tempDir)).toThrow(/E_WORKSPACE_INVALID/);
  });
});
