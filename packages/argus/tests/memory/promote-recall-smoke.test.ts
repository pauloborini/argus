import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VaultEngine } from "../../src/memory/vault-engine.js";
import { initWorkspace } from "../../src/workspace/workspace.js";

/**
 * S08 smoke — promote-shaped remember → recall (EVAL-001/002).
 * Shape mirrors Talos sink_adapter rememberCallShape (Sprint §7 D3–D5).
 * Does not call VaultEngine.sync before recall (same-session hot path).
 */
describe("promote-recall smoke (S08)", () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  function root(): string {
    tempDir = mkdtempSync(join(tmpdir(), "argus-promote-recall-"));
    initWorkspace(tempDir);
    return tempDir;
  }

  function uniqueClaim(suffix: string): string {
    return `S08-smoke-claim-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function chunkContains(
    chunks: Array<{ snippet?: string; content?: string; title?: string }>,
    claim: string,
  ): boolean {
    return chunks.some(
      (c) =>
        (c.snippet ?? "").includes(claim) ||
        (c.content ?? "").includes(claim) ||
        (c.title ?? "").includes(claim),
    );
  }

  it("EVAL-001: remember shape Talos (talos-handoff + anchor) → recall finds claim same-session", async () => {
    const cwd = root();
    const syncSpy = vi.spyOn(VaultEngine, "sync");
    const claim = uniqueClaim("happy");
    const remembered = await VaultEngine.remember(claim, {
      type: "decision",
      tags: ["talos-handoff", "anchor:eval:S08-smoke"],
      // links omitted (Sprint §7 D3 / D5a)
    }, cwd);

    expect(remembered.state).toBe("sucesso");
    expect(remembered.fts_indexed).toBe(true);
    expect(remembered.note_path).toMatch(/^decision\//);

    const notePath = join(cwd, ".argus", "memory", "vault", remembered.note_path as string);
    expect(existsSync(notePath)).toBe(true);
    const md = readFileSync(notePath, "utf-8");
    expect(md).toMatch(/talos-handoff/);
    expect(md).toMatch(/anchor:eval:S08-smoke/);
    expect(md).toMatch(/type: decision/);

    const recalled = await VaultEngine.recall(claim, { limit: 5 }, cwd);
    expect(recalled.chunks.length).toBeGreaterThanOrEqual(1);
    expect(chunkContains(recalled.chunks, claim)).toBe(true);
    expect(syncSpy).not.toHaveBeenCalled();
    syncSpy.mockRestore();
  });

  it("EVAL-002a: omit links → remember sucesso + recall finds claim", async () => {
    const cwd = root();
    const syncSpy = vi.spyOn(VaultEngine, "sync");
    const claim = uniqueClaim("omit-links");
    const remembered = await VaultEngine.remember(claim, {
      type: "decision",
      tags: ["talos-handoff", "anchor:eval:S08-smoke"],
    }, cwd);

    expect(remembered.state).toBe("sucesso");
    expect(remembered.fts_indexed).toBe(true);

    const recalled = await VaultEngine.recall(claim, { limit: 5 }, cwd);
    expect(chunkContains(recalled.chunks, claim)).toBe(true);
    expect(syncSpy).not.toHaveBeenCalled();
    syncSpy.mockRestore();
  });

  it("EVAL-002b: broken links path → remember sucesso, note persisted, recall finds claim (no hard-fail)", async () => {
    const cwd = root();
    const syncSpy = vi.spyOn(VaultEngine, "sync");
    const claim = uniqueClaim("broken-links");
    const broken = "path/that/does/not/exist.ts";

    let remembered: Awaited<ReturnType<typeof VaultEngine.remember>>;
    await expect(async () => {
      remembered = await VaultEngine.remember(claim, {
        type: "decision",
        tags: ["talos-handoff", "anchor:eval:S08-smoke"],
        links: [broken],
      }, cwd);
    }).not.toThrow();

    expect(remembered!.state).toBe("sucesso");
    expect(remembered!.fts_indexed).toBe(true);
    expect(remembered!.note_path).toBeTruthy();

    const notePath = join(cwd, ".argus", "memory", "vault", remembered!.note_path as string);
    expect(existsSync(notePath)).toBe(true);
    const md = readFileSync(notePath, "utf-8");
    expect(md).toContain(broken);
    expect(md).toContain(claim);
    expect(existsSync(join(cwd, broken))).toBe(false);

    const decisionDir = join(cwd, ".argus", "memory", "vault", "decision");
    expect(readdirSync(decisionDir).some((f) => f.endsWith(".md"))).toBe(true);

    const recalled = await VaultEngine.recall(claim, { limit: 5 }, cwd);
    expect(chunkContains(recalled.chunks, claim)).toBe(true);
    expect(syncSpy).not.toHaveBeenCalled();
    syncSpy.mockRestore();
  });
});
