import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runIndex } from "../src/commands/index-cmd.js";
import { openIndexDb } from "../src/storage/sqlite-index-store.js";
import { buildToolStub } from "../src/mcp/tools/stubs.js";
import { getIndexDbPath, initWorkspace } from "../src/workspace/workspace.js";

describe("pack context tool", () => {
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
    tempDir = mkdtempSync(join(tmpdir(), "cortex-pack-context-"));
    writeFileSync(
      join(tempDir, "utils.ts"),
      'import { helper } from "./dep";\nexport function calculateTotal() { helper(); return 1; }\n',
      "utf-8",
    );
    writeFileSync(join(tempDir, "dep.ts"), "export function helper() { return 1; }\n", "utf-8");
    initWorkspace(tempDir);
    process.chdir(tempDir);
    return tempDir;
  }

  it("pack-context empacota fonte indexada com refs rastreáveis", async () => {
    const root = setupWorkspace();
    expect(await runIndex()).toBe(0);

    const payload = buildToolStub("pack_context", root, {
      sources: ["utils.ts"],
      goal: "entender refactor",
      token_budget: 400,
      style: "balanced",
    });
    expect(["sucesso", "parcial", "stale"]).toContain(payload.state);
    expect(String(payload.packed_context)).toContain("utils.ts");
    expect((payload.origin_refs as unknown[]).length).toBeGreaterThan(0);
    expect(payload.reversibility).toBe("full");
  });

  it("pack-context emite handle quando budget corta material", async () => {
    const root = setupWorkspace();
    expect(await runIndex()).toBe(0);

    const payload = buildToolStub("pack_context", root, {
      sources: ["utils.ts"],
      goal: "entender refactor",
      token_budget: 80,
      style: "deep",
    });
    expect(["parcial", "stale"]).toContain(payload.state);
    expect(typeof payload.retrieve_handle).toBe("string");
    expect(payload.reversibility).toBe("full");
    expect((payload.removed_or_summarized as unknown[]).length).toBeGreaterThan(0);
    const handle = String(payload.retrieve_handle);
    expect(readFileSync(join(root, ".cortex", "packed-handles", handle, "manifest.json"), "utf-8")).toContain(handle);

    const db = openIndexDb(getIndexDbPath(root), { readonly: true });
    const row = db.prepare("SELECT handle FROM packed_handles WHERE handle = ?").get(handle) as
      | { handle: string }
      | undefined;
    db.close();
    expect(row?.handle).toBe(handle);

    const replay = buildToolStub("pack_context", root, {
      sources: [handle],
      goal: "reidratar",
      token_budget: 400,
      style: "deep",
    });
    expect(["sucesso", "parcial", "stale"]).toContain(replay.state);
    expect(String(replay.packed_context)).toContain("utils.ts");
  });

  it("pack-context degrada para partial quando handle perde segmento persistido", async () => {
    const root = setupWorkspace();
    expect(await runIndex()).toBe(0);

    const payload = buildToolStub("pack_context", root, {
      sources: ["utils.ts", "dep.ts"],
      goal: "entender refactor",
      token_budget: 110,
      style: "deep",
    });
    const handle = String(payload.retrieve_handle);
    rmSync(join(root, ".cortex", "packed-handles", handle, "segment-001.txt"));

    const replay = buildToolStub("pack_context", root, {
      sources: [handle],
      goal: "reidratar parcial",
      token_budget: 400,
      style: "deep",
    });
    expect(replay.state).toBe("parcial");
    expect(replay.reversibility).toBe("partial");
    expect((replay.limitations as string[]).some((item) => item.includes("Segmento ausente"))).toBe(true);
  });

  it("pack-context falha sem fontes úteis", async () => {
    const root = setupWorkspace();
    expect(await runIndex()).toBe(0);

    const payload = buildToolStub("pack_context", root, {
      sources: [],
      goal: "entender",
      token_budget: 120,
    });
    expect(payload.state).toBe("falha");
  });
});
