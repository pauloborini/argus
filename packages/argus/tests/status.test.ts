import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runIndex } from "../src/commands/index-cmd.js";
import {
  ARGUS_MCP_TOOLS_ENV,
  DEFAULT_LISTED_MCP_TOOLS,
  MCP_TOOL_NAMES,
} from "../src/mcp/tool-registry.js";
import { buildToolResponse } from "../src/mcp/tools/response.js";
import { SQLITE_SCHEMA_VERSION } from "../src/storage/sqlite-prepared.js";
import { getIndexDbPath, initWorkspace } from "../src/workspace/workspace.js";

describe("status stub e staleness", () => {
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

  function setupWorkspace(): string {
    originalCwd = process.cwd();
    tempDir = mkdtempSync(join(tmpdir(), "argus-status-"));
    writeFileSync(join(tempDir, "main.ts"), "export const main = true;\n", "utf-8");
    initWorkspace(tempDir);
    process.chdir(tempDir);
    return tempDir;
  }

  it("status sem manifest fica unknown/parcial", () => {
    const root = setupWorkspace();
    const payload = buildToolResponse("status", root);
    expect(payload.initialized).toBe(true);
    expect(payload.state).toBe("parcial");
    expect(payload.staleness).toBe("unknown");
    expect(payload.index_version).toBeNull();
    expect(payload.storage_backend).toBeNull();
  });

  it("AC-1.2.2 status relata default slim e forma de restaurar all", () => {
    const previous = process.env[ARGUS_MCP_TOOLS_ENV];
    delete process.env[ARGUS_MCP_TOOLS_ENV];
    try {
      const root = setupWorkspace();
      const payload = buildToolResponse("status", root);
      const surface = payload.mcp_surface as {
        slim: boolean;
        mode: string;
        listed_tools: string[];
        listed_count: number;
        registered_count: number;
        restore_all: string;
      };
      expect(surface).toBeTruthy();
      expect(surface.slim).toBe(true);
      expect(surface.mode).toBe("default");
      expect(surface.listed_tools).toEqual([...DEFAULT_LISTED_MCP_TOOLS]);
      expect(surface.listed_count).toBe(4);
      expect(surface.registered_count).toBe(MCP_TOOL_NAMES.length);
      expect(surface.restore_all).toBe(`${ARGUS_MCP_TOOLS_ENV}=all`);
    } finally {
      if (previous === undefined) {
        delete process.env[ARGUS_MCP_TOOLS_ENV];
      } else {
        process.env[ARGUS_MCP_TOOLS_ENV] = previous;
      }
    }
  });

  it("status rejeita path fora do workspace atual", () => {
    const root = setupWorkspace();
    const outside = mkdtempSync(join(tmpdir(), "argus-status-outside-"));
    try {
      const payload = buildToolResponse("status", outside);
      expect(payload.state).toBe("falha");
      expect(String(payload.message)).toContain("E_PATH_OUTSIDE_WORKSPACE");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
    expect(root).toBeTruthy();
  });

  it("status reporta limitations quando há arquivos não suportados no manifest", async () => {
    const root = setupWorkspace();
    writeFileSync(join(root, "notes.md"), "# notes\n", "utf-8");
    expect(await runIndex()).toBe(0);

    const payload = buildToolResponse("status", root, { response_format: "detailed" });
    expect(payload.state).toBe("parcial");
    const limitations = payload.limitations as string[];
    expect(limitations.some((line) => line.includes("não suportada"))).toBe(true);
  });

  it("status após index fica fresh/sucesso com coverage e backend sqlite", async () => {
    const root = setupWorkspace();
    expect(await runIndex()).toBe(0);
    const payload = buildToolResponse("status", root);
    expect(payload.state).toBe("sucesso");
    expect(payload.staleness).toBe("fresh");
    expect(payload.pending_files_count).toBe(0);
    expect(payload.storage_backend).toBe("sqlite");
    expect(payload.schema_version).toBe(SQLITE_SCHEMA_VERSION);
    expect(typeof payload.index_version).toBe("string");
    expect(String(payload.index_version)).toContain("sqlite@");
    const coverage = payload.coverage_by_language as Record<string, { symbols: number }>;
    expect(coverage.typescript?.symbols).toBeGreaterThan(0);
  });

  it("status após index Kotlin reporta coverage_level full (S32)", async () => {
    const root = setupWorkspace();
    writeFileSync(join(root, "Feature.kt"), "class FeatureController { fun run() {} }\n", "utf-8");
    expect(await runIndex()).toBe(0);

    const payload = buildToolResponse("status", root, { response_format: "detailed" });
    const coverage = payload.coverage_by_language as Record<
      string,
      { symbols: number; coverage_level?: string }
    >;
    expect(coverage.kotlin?.symbols).toBeGreaterThan(0);
    expect(coverage.kotlin?.coverage_level).toBe("full");
  });

  it("arquivo grande (MAX_FILE_SIZE) não envenena staleness; permanece fresh", async () => {
    const root = setupWorkspace();
    writeFileSync(join(root, "asset.bin"), "x".repeat(2 * 1024 * 1024 + 1), "utf-8");
    expect(await runIndex()).toBe(0);

    const payload = buildToolResponse("status", root);
    expect(payload.staleness).toBe("fresh");
    expect(payload.pending_files_count).toBe(0);
    expect(payload.state).toBe("sucesso");
  });

  it("status detecta stale quando arquivo muda", async () => {
    const root = setupWorkspace();
    expect(await runIndex()).toBe(0);
    writeFileSync(join(root, "main.ts"), "export const main = false;\n", "utf-8");
    const payload = buildToolResponse("status", root);
    expect(payload.state).toBe("stale");
    expect(payload.staleness).toBe("stale");
    expect(Number(payload.pending_files_count)).toBeGreaterThan(0);
  });

  it("tools semânticas pendentes degradam honestamente com índice SQLite", async () => {
    const root = setupWorkspace();
    expect(await runIndex()).toBe(0);

    const packPayload = buildToolResponse("pack_context", root, {
      sources: ["main.ts"],
      goal: "entender fluxo",
      token_budget: 120,
    });
    expect(["sucesso", "parcial", "stale"]).toContain(packPayload.state);
    expect(typeof packPayload.packed_context).toBe("string");
  });

  it("status degradado quando manifest está corrompido", async () => {
    const root = setupWorkspace();
    expect(await runIndex()).toBe(0);
    const manifestPath = join(root, ".argus", "file-manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
      schema_version: string;
      generated_at: string;
      root_path: string;
      file_count: number;
      files: unknown[];
    };
    manifest.files = [{ relative_path: "main.ts", content_hash: 123, size_bytes: "22", mtime_ms: null }];
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf-8");

    const payload = buildToolResponse("status", root);
    expect(payload.state).toBe("parcial");
    expect(payload.staleness).toBe("unknown");
    expect(String(payload.message)).toContain("E_INDEX_CORRUPTED");
  });

  it("status falha quando banco SQLite está corrompido", async () => {
    const root = setupWorkspace();
    expect(await runIndex()).toBe(0);
    writeFileSync(getIndexDbPath(root), "not-a-sqlite-db", "utf-8");

    const payload = buildToolResponse("status", root);
    expect(payload.state).toBe("falha");
    expect(String(payload.message)).toContain("E_INDEX_CORRUPTED");
  });
});
