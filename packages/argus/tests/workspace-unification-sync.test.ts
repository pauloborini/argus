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
import { runIndex } from "../src/commands/index-cmd.js";
import { runMarkDirty } from "../src/commands/mark-dirty.js";
import { runSync } from "../src/commands/sync.js";
import { withSyncLock } from "../src/concurrency/sync-lock.js";
import { readDirtyFlag } from "../src/discovery/dirty-flag.js";
import { readManifest } from "../src/discovery/manifest.js";
import { buildStatusResponse } from "../src/mcp/tools/status.js";
import {
  getDirtyFlagPath,
  getIndexDbPath,
  getManifestPath,
  getMetadataPath,
  getStatePaths,
  getSyncLockPath,
  initWorkspace,
  readWorkspaceMetadata,
  type WorkspaceMetadata,
} from "../src/workspace/workspace.js";

/**
 * Plano 2 — writers estruturais unificados.
 * Fixture obrigatória: `.argus` em S com `root_path` stale apontando para T
 * (cwd ≠ root_path textual). Prova ancorada no seam S-sync-cycle sem mock de paths.
 */
describe("workspace unification — sync/mark-dirty/lock", () => {
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

  /**
   * Cria S (workspace real) + T (tree paralelo / root stale).
   * Indexa em S com metadata coerente, depois corrompe `root_path` → T.
   */
  async function fixtureSplitIndexed(): Promise<{
    S: string;
    T: string;
    stateS: ReturnType<typeof getStatePaths>;
    stateT: ReturnType<typeof getStatePaths>;
  }> {
    originalCwd = process.cwd();
    tempDir = mkdtempSync(join(tmpdir(), "argus-ws-unify-"));
    const Sraw = join(tempDir, "canonical-S");
    const Traw = join(tempDir, "stale-T");
    mkdirSync(Sraw, { recursive: true });
    mkdirSync(Traw, { recursive: true });
    const S = real(Sraw);
    const T = real(Traw);
    cleanups.push(tempDir);

    writeFileSync(join(S, "app.ts"), "export const app = 1;\n", "utf-8");
    writeFileSync(join(S, "notes.md"), "# docs only\n", "utf-8");
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

  it("AC-2.1.1/2.1.2: sync+lock escrevem só em S após metadata divergente", async () => {
    const { S, T, stateS, stateT } = await fixtureSplitIndexed();
    expect(existsSync(stateS.manifest)).toBe(true);
    expect(existsSync(stateS.indexDb)).toBe(true);

    corruptRootPathTo(S, T);
    // Tree paralelo vazio — qualquer escrita em T prova dual-write.
    expect(existsSync(stateT.stateDir)).toBe(false);

    const beforeManifest = readManifest(stateS.manifest);
    expect(beforeManifest).not.toBeNull();
    const oldGeneratedAt = "2000-01-01T00:00:00.000Z";
    writeFileSync(
      stateS.manifest,
      JSON.stringify({ ...beforeManifest!, generated_at: oldGeneratedAt }, null, 2) + "\n",
      "utf-8",
    );

    // Observa lock no path canônico durante a seção crítica (AC-2.1.2).
    const lockPath = getSyncLockPath(S);
    expect(lockPath).toBe(stateS.syncLock);
    let sawLockOnS = false;
    const lockProbe = await withSyncLock(S, async () => {
      sawLockOnS = existsSync(lockPath);
      expect(existsSync(getSyncLockPath(T))).toBe(false);
      return "held";
    });
    expect(lockProbe.acquired).toBe(true);
    expect(lockProbe.result).toBe("held");
    expect(sawLockOnS).toBe(true);
    expect(existsSync(lockPath)).toBe(false);

    // startCwd=S explícito (não depende só do chdir) com metadata ainda divergente.
    expect(await runSync({ cwd: S, quiet: true })).toBe(0);

    // Heal: metadata alinhada a S.
    expect(readWorkspaceMetadata(S)?.root_path).toBe(S);

    // Artefatos só sob S — não sob T (AC-2.1.1 / INV-W1).
    expect(existsSync(stateS.manifest)).toBe(true);
    expect(existsSync(stateS.indexDb)).toBe(true);
    expect(existsSync(stateT.stateDir)).toBe(false);
    expect(existsSync(getManifestPath(T))).toBe(false);
    expect(existsSync(getIndexDbPath(T))).toBe(false);
    expect(existsSync(getDirtyFlagPath(T))).toBe(false);

    const afterManifest = readManifest(stateS.manifest);
    expect(afterManifest?.root_path).toBe(S);
    // P4: generated_at refresca mesmo em no-op de conteúdo.
    expect(afterManifest?.generated_at).toBeTruthy();
    expect(afterManifest!.generated_at > oldGeneratedAt).toBe(true);

    const status = buildStatusResponse(S);
    expect(status.staleness).toBe("fresh");
    expect(existsSync(stateS.dirtyFlag)).toBe(false);
  });

  it("AC-2.2.1/2.2.2: mark-dirty → status stale → sync → fresh no mesmo root", async () => {
    const { S, T, stateS, stateT } = await fixtureSplitIndexed();
    corruptRootPathTo(S, T);

    expect(runMarkDirty({ cwd: S })).toBe(0);

    // Heal + dirty só em S (AC-2.2.1).
    expect(readWorkspaceMetadata(S)?.root_path).toBe(S);
    expect(existsSync(stateS.dirtyFlag)).toBe(true);
    expect(readDirtyFlag(S)?.force_full).toBe(true);
    expect(existsSync(stateT.stateDir)).toBe(false);
    expect(existsSync(getDirtyFlagPath(T))).toBe(false);

    // Status no mesmo root vê dirty (AC-2.2.2).
    const staleStatus = buildStatusResponse(S);
    expect(staleStatus.staleness).toBe("stale");
    expect(staleStatus.dirty_pending).toEqual({
      paths: 0,
      force_full: true,
      since_ref: null,
    });

    expect(await runSync({ cwd: S, quiet: true })).toBe(0);

    expect(existsSync(stateS.dirtyFlag)).toBe(false);
    expect(existsSync(stateT.stateDir)).toBe(false);

    const freshStatus = buildStatusResponse(S);
    expect(freshStatus.staleness).toBe("fresh");
    expect(freshStatus.dirty_pending).toBeNull();
  });

  it("unsupported-only tree: sync com 0 símbolos estruturais deixa status fresh", async () => {
    originalCwd = process.cwd();
    tempDir = mkdtempSync(join(tmpdir(), "argus-ws-unify-md-"));
    const base = real(tempDir);
    const Sraw = join(base, "docs-only");
    mkdirSync(Sraw, { recursive: true });
    const S = real(Sraw);

    writeFileSync(join(S, "readme.md"), "# only markdown\n", "utf-8");
    writeFileSync(join(S, "data.json"), "{ \"ok\": true }\n", "utf-8");
    initWorkspace(S);
    process.chdir(S);
    expect(await runIndex()).toBe(0);

    const metaPath = getMetadataPath(S);
    const meta = JSON.parse(readFileSync(metaPath, "utf-8")) as WorkspaceMetadata;
    const Traw = join(base, "stale-T");
    mkdirSync(Traw, { recursive: true });
    const T = real(Traw);
    writeFileSync(
      metaPath,
      JSON.stringify({ ...meta, root_path: T }, null, 2) + "\n",
      "utf-8",
    );

    expect(runMarkDirty({ cwd: S })).toBe(0);
    expect(buildStatusResponse(S).staleness).toBe("stale");

    expect(await runSync({ cwd: S, full: true, quiet: true })).toBe(0);
    expect(existsSync(getDirtyFlagPath(T))).toBe(false);
    expect(existsSync(join(T, ".argus"))).toBe(false);

    const status = buildStatusResponse(S);
    expect(status.staleness).toBe("fresh");
    // Cobertura pode ser vazia / 0 símbolos — ainda fresh (INV-W3 path unificado).
    expect(status.state).toMatch(/sucesso|parcial/);
  });
});
