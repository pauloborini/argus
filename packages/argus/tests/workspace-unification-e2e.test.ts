import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { formatRepoStatusHuman } from "../src/commands/format-status.js";
import { runIndex } from "../src/commands/index-cmd.js";
import { runMarkDirty } from "../src/commands/mark-dirty.js";
import { runSync } from "../src/commands/sync.js";
import { FakeEmbedder } from "../src/embeddings/embedder.js";
import { readDirtyFlag } from "../src/discovery/dirty-flag.js";
import { buildRecallResponseAsync } from "../src/mcp/tools/recall.js";
import { buildRememberResponse } from "../src/mcp/tools/remember.js";
import { buildStatusResponse } from "../src/mcp/tools/status.js";
import { createMcpServer } from "../src/mcp/server.js";
import { getMemoryDbPath } from "../src/memory/paths.js";
import {
  findShadowArgusState,
  resolveWorkspaceRoot,
  type WorkspaceHandle,
} from "../src/workspace/resolve-workspace.js";
import {
  getDirtyFlagPath,
  getIndexDbPath,
  getManifestPath,
  getMetadataPath,
  getStatePaths,
  initWorkspace,
  readWorkspaceMetadata,
  type WorkspaceMetadata,
} from "../src/workspace/workspace.js";

/**
 * Plano 7 — regressão integrada ponta a ponta da trilha de unificação.
 *
 * Jornada E2E num único teste, sobre a mesma fixture split (`.argus` em S com
 * `root_path` stale apontando para T):
 *
 *   resolve+heal → mark-dirty → sync → status fresh (loop status↔sync morto) →
 *   remember → recall same-session sem sync → status memória cofre≡índice →
 *   sombra não escrita.
 *
 * Prova ancorada nos seams S-sync-cycle + S-memory + S-lifecycle. Sem mock de
 * paths; todas as funções (runSync, runMarkDirty, buildStatusResponse,
 * VaultEngine, resolveWorkspaceRoot, findShadowArgusState) são reais. Fixture
 * com `cwd ≠ root_path` é obrigatória (INV-W1).
 */
describe("workspace unification — E2E regressão integrada (Plano 7)", () => {
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

  function real(path: string): string {
    return realpathSync.native(path);
  }

  async function fixtureSplitE2E(): Promise<{
    S: string;
    T: string;
    nestedInS: string;
    stateS: ReturnType<typeof getStatePaths>;
    stateT: ReturnType<typeof getStatePaths>;
  }> {
    originalCwd = process.cwd();
    tempDir = mkdtempSync(join(tmpdir(), "argus-ws-e2e-"));
    const Sraw = join(tempDir, "canonical-S");
    const Traw = join(tempDir, "stale-T");
    const nestedRaw = join(Sraw, "packages", "app");
    mkdirSync(Sraw, { recursive: true });
    mkdirSync(Traw, { recursive: true });
    mkdirSync(nestedRaw, { recursive: true });
    const S = real(Sraw);
    const T = real(Traw);
    const nestedInS = real(nestedRaw);

    // Código real em S (+ subdiretório para provar walk-up CLI≡MCP do Plano 4).
    writeFileSync(
      join(S, "billing.ts"),
      "export function calculateTotal(items: number[]): number {\n  return items.reduce((a, b) => a + b, 0);\n}\n",
      "utf-8",
    );
    writeFileSync(
      join(nestedInS, "feature.ts"),
      "export function shipFeature(): boolean { return true; }\n",
      "utf-8",
    );
    writeFileSync(join(S, "design.md"), "# decisões\n", "utf-8");

    initWorkspace(S);
    process.chdir(S);
    expect(await runIndex()).toBe(0);

    return { S, T, nestedInS, stateS: getStatePaths(S), stateT: getStatePaths(T) };
  }

  function corruptRootPathTo(S: string, T: string): void {
    const meta = readWorkspaceMetadata(S);
    expect(meta).not.toBeNull();
    const stale: WorkspaceMetadata = { ...meta!, root_path: T };
    writeFileSync(getMetadataPath(S), JSON.stringify(stale, null, 2) + "\n", "utf-8");
    expect(readWorkspaceMetadata(S)?.root_path).toBe(T);
  }

  it("AC-7.1.1 / INV-W1,W3,W4,W5,W7: jornada unificada S sem alterar T", async () => {
    const { S, T, nestedInS, stateS, stateT } = await fixtureSplitE2E();
    corruptRootPathTo(S, T);
    // Sombra física preexistente: qualquer alteração/merge/remoção em T viola D5.
    initWorkspace(T);
    const shadowMarker = join(stateT.stateDir, "shadow-marker.txt");
    writeFileSync(shadowMarker, "estado-sombra-intacto\n", "utf-8");
    expect(readWorkspaceMetadata(T)?.root_path).toBe(T);

    // --- resolve + heal a partir de subdiretório (walk-up CLI≡MCP) ---
    const handle = resolveWorkspaceRoot(nestedInS) as WorkspaceHandle;
    expect(handle).not.toBeNull();
    expect(handle.rootPath).toBe(S);
    expect(handle.healed).toBe(true);
    expect(readWorkspaceMetadata(S)?.root_path).toBe(S);
    expect(readFileSync(shadowMarker, "utf-8")).toBe("estado-sombra-intacto\n");

    // --- mark-dirty no mesmo root (não em T) ---
    expect(runMarkDirty({ cwd: nestedInS })).toBe(0);
    expect(existsSync(stateS.dirtyFlag)).toBe(true);
    expect(readDirtyFlag(S)?.force_full).toBe(true);
    expect(existsSync(getDirtyFlagPath(T))).toBe(false);

    // --- status vê dirty no mesmo root (loop ainda não morto) ---
    const staleStatus = buildStatusResponse(nestedInS);
    expect(staleStatus.staleness).toBe("stale");
    expect(staleStatus.dirty_pending?.force_full).toBe(true);

    // --- sync no root canônico ---
    expect(await runSync({ cwd: nestedInS, quiet: true })).toBe(0);
    expect(existsSync(stateS.dirtyFlag)).toBe(false);

    // --- INV-W3: loop status↔sync morto — status agora fresh, não pede sync ---
    const freshStatus = buildStatusResponse(nestedInS);
    expect(freshStatus.staleness).toBe("fresh");
    expect(freshStatus.dirty_pending).toBeNull();
    // Estrutural e memória observam o mesmo root.
    expect(freshStatus.initialized).toBe(true);

    // --- remember no mesmo root (D3: após resolve, I/O usa rootPath) ---
    // Espelha o MCP server: resolve (walk-up) uma vez, depois opera em handle.rootPath.
    const root = handle.rootPath;
    const unique = `e2e-decision-${Date.now()}`;
    const remembered = await buildRememberResponse(
      root,
      { content: `# Decisão E2E\n\n${unique} cofre unificado`, type: "decision" },
      new FakeEmbedder(),
    );
    expect(remembered.state).toBe("sucesso");
    expect(existsSync(getMemoryDbPath(S))).toBe(true);
    expect(existsSync(getMemoryDbPath(T))).toBe(false);

    // --- recall no mesmo db ---
    const recalled = await buildRecallResponseAsync(
      root,
      { query: unique, limit: 5, include_snippets: true },
      new FakeEmbedder(),
    );
    expect(recalled.state).not.toBe("falha");
    const chunks = (recalled.chunks as Array<{ title?: string }> | undefined) ?? [];
    expect(chunks.length).toBeGreaterThan(0);
    expect(JSON.stringify(recalled)).toContain(unique);

    // --- INV-W4: memória ≡ índice compartilham o mesmo root ---
    const statusAfterMemory = buildStatusResponse(nestedInS);
    const memory = statusAfterMemory.memory as { notes_count?: number };
    expect(memory?.notes_count).toBeGreaterThan(0);
    expect(existsSync(stateS.manifest)).toBe(true);
    expect(existsSync(stateS.indexDb)).toBe(true);

    // --- INV-W7: formatter real separa índice/cofre e não repede sync ---
    const humanStatus = formatRepoStatusHuman(statusAfterMemory, S);
    expect(humanStatus).toContain("Última sync do índice:");
    expect(humanStatus).toContain("Última sync do cofre:");
    expect(humanStatus).not.toContain("Última sincronização:");
    expect(humanStatus).not.toContain("Execute argus sync");
    expect(humanStatus).not.toContain("rode argus sync");

    // --- INV-W5 / D5: sombra não é apagada nem escrita; diagnóstico é honesto ---
    // T já continha estado; a jornada não o escreveu, apagou nem mesclou.
    const shadow = findShadowArgusState(handle);
    expect(shadow.canonical).toBe(S);
    expect(shadow.shadows).toContain(T);
    expect(shadow.previousRootShadow).toBe(T);
    // O handle preserva o histórico do heal (previousRootPath = T).
    expect(handle.previousRootPath).toBe(T);
    expect(readWorkspaceMetadata(T)?.root_path).toBe(T);
    expect(readFileSync(shadowMarker, "utf-8")).toBe("estado-sombra-intacto\n");

    // --- camada cruzada final: nenhum artefato de estado sob T ---
    expect(existsSync(getManifestPath(T))).toBe(false);
    expect(existsSync(getIndexDbPath(T))).toBe(false);
    expect(existsSync(getDirtyFlagPath(T))).toBe(false);
    expect(existsSync(getMemoryDbPath(T))).toBe(false);
  });

  it("INV-W6: ListTools real preserva surface slim de cinco tools", async () => {
    const { S, nestedInS } = await fixtureSplitE2E();
    // Status mantém observabilidade da mesma política.
    const status = buildStatusResponse(nestedInS);
    expect(status.initialized).toBe(true);
    const surface = (
      status as unknown as { mcp_surface?: { slim?: boolean; listed_tools?: string[] } }
    ).mcp_surface;
    expect(surface?.slim).toBe(true);
    expect(surface?.listed_tools).toEqual([
      "explore",
      "pack_context",
      "recall",
      "remember",
      "status",
    ]);

    // Prova ancorada no seam real Client ↔ Server; sem usar payload auxiliar
    // como proxy de ListTools.
    const server = createMcpServer({ autoSync: false, listedToolsEnv: undefined });
    const client = new Client({ name: "workspace-unification-e2e", version: "0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual([
        "explore",
        "pack_context",
        "recall",
        "remember",
        "status",
      ]);
    } finally {
      await client.close();
    }
    expect(readWorkspaceMetadata(S)?.root_path).toBe(S);
  });
});
