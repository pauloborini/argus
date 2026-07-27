import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FakeEmbedder } from "../src/embeddings/embedder.js";
import { buildRememberResponse } from "../src/mcp/tools/remember.js";
import { buildRecallResponseAsync } from "../src/mcp/tools/recall.js";
import { buildStatusResponse } from "../src/mcp/tools/status.js";
import { buildToolResponseAsync } from "../src/mcp/tools/response.js";
import { buildPackContextResponse, buildRetrieveResponse } from "../src/mcp/tools/pack.js";
import { buildIndexEnvelope } from "../src/mcp/tools/common.js";
import {
  createRetrieveHandleId,
  getPackedHandlePath,
  getPackedHandlesDir,
  readStoredPackHandle,
  writeStoredPackHandle,
} from "../src/mcp/tools/retrieve-handle-store.js";
import { closeIndexDb, openIndexDb } from "../src/storage/sqlite-index-store.js";
import { VaultEngine } from "../src/memory/vault-engine.js";
import { getMemoryDbPath, getMemoryRoot } from "../src/memory/paths.js";
import {
  getIndexDbPath,
  getMetadataPath,
  getPackedHandlesDirPath,
  getStatePaths,
  initWorkspace,
  readWorkspaceMetadata,
  type WorkspaceMetadata,
} from "../src/workspace/workspace.js";
import { runIndex } from "../src/commands/index-cmd.js";

/**
 * Plano 3 — memória e packed-handles no root canônico.
 * Fixture obrigatória: `.argus` em S com `root_path` stale apontando para T.
 * Prova ancorada no seam S-memory (e handles) sem mock de paths.
 */
describe("workspace unification — memory/handles", () => {
  let tempDir: string | undefined;
  let originalCwd: string | undefined;
  const cleanups: string[] = [];

  afterEach(() => {
    if (originalCwd) {
      process.chdir(originalCwd);
      originalCwd = undefined;
    }
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

  async function fixtureSplit(): Promise<{
    S: string;
    T: string;
    stateS: ReturnType<typeof getStatePaths>;
    stateT: ReturnType<typeof getStatePaths>;
  }> {
    originalCwd = process.cwd();
    tempDir = mkdtempSync(join(tmpdir(), "argus-ws-mem-"));
    const Sraw = join(tempDir, "canonical-S");
    const Traw = join(tempDir, "stale-T");
    mkdirSync(Sraw, { recursive: true });
    mkdirSync(Traw, { recursive: true });
    const S = real(Sraw);
    const T = real(Traw);
    cleanups.push(tempDir);

    writeFileSync(join(S, "app.ts"), "export function packTarget() { return 1; }\n", "utf-8");
    initWorkspace(S);
    process.chdir(S);
    expect(await runIndex()).toBe(0);

    return {
      S,
      T,
      stateS: getStatePaths(S),
      stateT: getStatePaths(T),
    };
  }

  function corruptRootPathTo(S: string, T: string): void {
    const meta = readWorkspaceMetadata(S);
    expect(meta).not.toBeNull();
    const stale: WorkspaceMetadata = { ...meta!, root_path: T };
    writeFileSync(getMetadataPath(S), JSON.stringify(stale, null, 2) + "\n", "utf-8");
    expect(readWorkspaceMetadata(S)?.root_path).toBe(T);
  }

  it("AC-3.1.1: remember/status gravam e leem só em S; T sem a nota", async () => {
    const { S, T, stateS, stateT } = await fixtureSplit();
    corruptRootPathTo(S, T);
    expect(existsSync(stateT.stateDir)).toBe(false);

    const unique = `workspace-unify-note-${Date.now()}`;
    const remembered = await buildRememberResponse(
      S,
      { content: `# Decisão\n\n${unique} canonical root only`, type: "decision" },
      new FakeEmbedder(),
    );
    expect(remembered.state).toBe("sucesso");

    // Artefatos de memória sob S/.argus/memory
    expect(existsSync(getMemoryRoot(S))).toBe(true);
    expect(existsSync(getMemoryDbPath(S))).toBe(true);
    expect(existsSync(stateS.memoryDir)).toBe(true);

    // Tree paralelo T não recebe memória
    expect(existsSync(getMemoryRoot(T))).toBe(false);
    expect(existsSync(stateT.memoryDir)).toBe(false);

    const vaultStatus = VaultEngine.status(S);
    expect(vaultStatus.notes_count).toBeGreaterThan(0);

    const status = buildStatusResponse(S);
    const memory = status.memory as { notes_count?: number } | undefined;
    expect(memory?.notes_count).toBeGreaterThan(0);
    // Status healou metadata; estrutural e memória no mesmo root
    expect(readWorkspaceMetadata(S)?.root_path).toBe(S);
    expect(existsSync(stateT.stateDir)).toBe(false);
  });

  it("AC-3.1.2: semantic_search memory e recall leem o mesmo db do remember", async () => {
    const { S, T } = await fixtureSplit();
    corruptRootPathTo(S, T);

    const unique = `unify-recall-${Date.now()}`;
    const remembered = await buildRememberResponse(
      S,
      { content: `# RecallTarget\n\n${unique} shared vault`, type: "decision" },
      new FakeEmbedder(),
    );
    expect(remembered.state).toBe("sucesso");
    // Hot path remember não exige sync wipe; FTS sync para recall lexical.
    expect(VaultEngine.sync(S).state).toBe("sucesso");

    const recalled = await buildRecallResponseAsync(
      S,
      { query: unique, limit: 5, include_snippets: true },
      new FakeEmbedder(),
    );
    expect(recalled.state).not.toBe("falha");
    const chunks = (recalled.chunks as Array<{ path?: string; title?: string }> | undefined) ?? [];
    expect(chunks.length).toBeGreaterThan(0);

    const semantic = await buildToolResponseAsync(
      "semantic_search",
      S,
      { query: unique, domain: "memory", response_format: "detailed" },
      { embedder: new FakeEmbedder() },
    );
    expect(semantic.state).not.toBe("falha");
    const candidates = (semantic.candidates as unknown[] | undefined) ?? [];
    expect(candidates.length).toBeGreaterThan(0);

    // T nunca teve o cofre
    expect(existsSync(getMemoryDbPath(T))).toBe(false);
  });

  it("AC-3.2.1: write/read packed-handles usam S/.argus/packed-handles e index.db de S", async () => {
    const { S, T, stateS, stateT } = await fixtureSplit();
    corruptRootPathTo(S, T);

    const handle = createRetrieveHandleId("rh");
    const reversibility = writeStoredPackHandle(S, {
      handle,
      created_at: new Date().toISOString(),
      goal: "unify-handles",
      style: "balanced",
      token_budget: 100,
      manifest_hash: null,
      schema_version: null,
      segments: [
        {
          ref: "app.ts",
          text: "export function packTarget() { return 1; }",
          originRefs: [{ ref: "packTarget", path: "app.ts", start_line: 1, end_line: 1 }],
        },
      ],
    });
    expect(reversibility).toBe("full");

    const expectedDir = getPackedHandlesDirPath(S);
    expect(getPackedHandlesDir(S)).toBe(expectedDir);
    expect(existsSync(join(expectedDir, handle, "manifest.json"))).toBe(true);
    expect(getPackedHandlePath(S, handle)).toBe(join(expectedDir, handle));
    expect(existsSync(stateS.packedHandlesDir)).toBe(true);
    expect(existsSync(stateT.packedHandlesDir)).toBe(false);

    const stored = readStoredPackHandle(S, handle);
    expect(stored.found).toBe(true);
    expect(stored.segments.length).toBe(1);

    // Registro no index.db do mesmo root (não em T)
    const db = openIndexDb(getIndexDbPath(S));
    try {
      const row = db
        .prepare("SELECT handle FROM packed_handles WHERE handle = ?")
        .get(handle) as { handle: string } | undefined;
      expect(row?.handle).toBe(handle);
    } finally {
      closeIndexDb(db);
    }
    expect(existsSync(getIndexDbPath(T))).toBe(false);

    // Heal de status não cria estado em T
    buildStatusResponse(S);
    expect(existsSync(stateT.stateDir)).toBe(false);
    // packed-handles sob S permanece o único
    const underS = readdirSync(stateS.packedHandlesDir);
    expect(underS).toContain(handle);
  });

  it("INV-W4: remember/recall sem workspace falham sem criar estado sombra", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "argus-ws-mem-missing-"));
    const startCwd = real(tempDir);

    const remembered = await buildRememberResponse(
      startCwd,
      { content: "não deve criar cofre órfão", type: "decision" },
      new FakeEmbedder(),
    );
    const recalled = await buildRecallResponseAsync(
      startCwd,
      { query: "cofre órfão" },
      new FakeEmbedder(),
    );
    const packed = await buildToolResponseAsync(
      "pack_context",
      startCwd,
      {
        sources: ["memory:nota-inexistente"],
        goal: "não criar handle órfão",
        token_budget: 100,
        synthesize: true,
      },
      { embedder: new FakeEmbedder() },
    );

    expect(remembered.state).toBe("falha");
    expect(remembered.message).toMatch(/E_WORKSPACE_INVALID/);
    expect(recalled.state).toBe("falha");
    expect(recalled.message).toMatch(/E_WORKSPACE_INVALID/);
    expect(packed.state).toBe("falha");
    expect(packed.message).toMatch(/E_WORKSPACE_INVALID/);
    expect(existsSync(join(startCwd, ".argus"))).toBe(false);
  });

  it("INV-W4/W5: seams diretos de pack/retrieve/status não usam cwd órfão", () => {
    tempDir = mkdtempSync(join(tmpdir(), "argus-ws-mem-orphan-"));
    const startCwd = real(tempDir);
    const orphanVault = join(startCwd, ".argus", "memory", "vault", "decision");
    mkdirSync(orphanVault, { recursive: true });
    writeFileSync(join(orphanVault, "orphan.md"), "# órfã\n\nnão canônica\n", "utf-8");

    const envelope = buildIndexEnvelope(startCwd);
    const packed = buildPackContextResponse(startCwd, envelope, {
      sources: ["memory:decision/orphan.md"],
      goal: "não consumir estado órfão",
      token_budget: 200,
    });
    const retrieved = buildRetrieveResponse(startCwd, {
      handle: "mh_0123456789abcdef",
    });
    const status = buildStatusResponse(startCwd);

    expect(packed.state).toBe("falha");
    expect(packed.message).toMatch(/E_WORKSPACE_INVALID/);
    expect(retrieved.state).toBe("falha");
    expect(retrieved.message).toMatch(/E_WORKSPACE_INVALID/);
    expect(status.state).toBe("falha");
    expect((status.memory as { initialized: boolean }).initialized).toBe(false);
    expect(existsSync(join(startCwd, ".argus", "index.db"))).toBe(false);
    expect(existsSync(join(startCwd, ".argus", "packed-handles"))).toBe(false);
  });
});
