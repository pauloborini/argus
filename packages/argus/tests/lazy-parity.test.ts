/**
 * S7 — Hot paths lazy + parity de resultado (Plano 5).
 *
 * Prova ancorada: instrumentação real em `loadStructuralIndexForRead` /
 * `discoverFiles` + payloads via `buildToolResponse` / `runSync` reais.
 * Não mocka o seam sob prova.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runIndex } from "../src/commands/index-cmd.js";
import { runSync } from "../src/commands/sync.js";
import { markDirty, readDirtyFlag } from "../src/discovery/dirty-flag.js";
import {
  getDiscoverWalkCount,
  resetDiscoverWalkCount,
} from "../src/discovery/walk.js";
import { buildToolResponse } from "../src/mcp/tools/response.js";
import {
  getFullStructuralLoadCount,
  getStructuralMetaLoadCount,
  loadStructuralIndexForRead,
  resetFullStructuralLoadCount,
  resetStructuralMetaLoadCount,
} from "../src/storage/index-persistence.js";
import { initWorkspace } from "../src/workspace/workspace.js";

function resetLoaderCounters(): void {
  resetFullStructuralLoadCount();
  resetStructuralMetaLoadCount();
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

function initGitRepo(cwd: string): void {
  git(cwd, ["init", "-q"]);
  git(cwd, ["config", "user.email", "test@example.com"]);
  git(cwd, ["config", "user.name", "Test"]);
  git(cwd, ["config", "commit.gpgsign", "false"]);
}

describe("S7 — lazy hot paths e parity", () => {
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

  function setupFixture(withGit = false): string {
    originalCwd = process.cwd();
    tempDir = mkdtempSync(join(tmpdir(), "argus-s7-lazy-"));
    writeFileSync(
      join(tempDir, "utils.ts"),
      [
        "export function helper(): number {",
        "  return 1;",
        "}",
        "export function calculateTotal(a: number, b: number): number {",
        "  return helper() + a + b;",
        "}",
        "",
      ].join("\n"),
      "utf-8",
    );
    writeFileSync(
      join(tempDir, "dep.ts"),
      ['import { calculateTotal } from "./utils.ts";', "export const value = calculateTotal(1, 2);", ""].join(
        "\n",
      ),
      "utf-8",
    );
    if (withGit) {
      initGitRepo(tempDir);
      git(tempDir, ["add", "-A"]);
      git(tempDir, ["commit", "-q", "-m", "init"]);
    }
    initWorkspace(tempDir);
    process.chdir(tempDir);
    return tempDir;
  }

  it("AC-5.1.1 explore e pack balanced não chamam loadStructuralIndex full", async () => {
    const root = setupFixture();
    expect(await runIndex()).toBe(0);

    resetLoaderCounters();
    const explore = buildToolResponse("explore", root, { target: "calculateTotal" });
    const pack = buildToolResponse("pack_context", root, {
      sources: ["calculateTotal"],
      goal: "entender calculateTotal",
      style: "balanced",
      token_budget: 400,
    });

    expect(explore.state).not.toBe("falha");
    expect(pack.state).not.toBe("falha");
    expect(getFullStructuralLoadCount()).toBe(0);
    // explore/pack usam envelope lite (meta), nunca full-load.
    expect(getStructuralMetaLoadCount()).toBeGreaterThan(0);

    const snippets = explore.snippets as Array<{ body?: string }> | undefined;
    expect(snippets?.some((s) => s.body?.includes("return 1") || s.body?.includes("helper()"))).toBe(
      true,
    );
    const packed = String(pack.packed_context ?? "");
    expect(packed.includes("calculateTotal") || packed.includes("helper")).toBe(true);
  });

  it("AC-5.1.2 retrieve não constrói envelope estrutural; status não faz full-load", async () => {
    const root = setupFixture();
    expect(await runIndex()).toBe(0);

    const packed = buildToolResponse("pack_context", root, {
      sources: ["utils.ts"],
      goal: "pack utils",
      style: "balanced",
      token_budget: 80,
    });
    const handle = String(packed.retrieve_handle ?? "");
    expect(handle).toMatch(/^rh_/);

    resetLoaderCounters();
    const retrieved = buildToolResponse("retrieve", root, { handle });
    // Retrieve não passa por buildIndexEnvelope: zero full e zero meta.
    expect(retrieved.state).toBe("sucesso");
    expect(getFullStructuralLoadCount()).toBe(0);
    expect(getStructuralMetaLoadCount()).toBe(0);

    resetLoaderCounters();
    const status = buildToolResponse("status", root);
    expect(status.initialized).toBe(true);
    expect(status.storage_backend).toBe("sqlite");
    expect(status.coverage_by_language).toBeTruthy();
    expect(getFullStructuralLoadCount()).toBe(0);
    // Status: uma carga meta, sem duplicar full.
    expect(getStructuralMetaLoadCount()).toBe(1);
  });

  it("AC-5.1.3 diff_impact carrega boundary necessário e preserva resultado da fixture", async () => {
    const root = setupFixture(true);
    expect(await runIndex()).toBe(0);
    writeFileSync(
      join(root, "utils.ts"),
      [
        "export function helper(): number {",
        "  return 2;",
        "}",
        "export function calculateTotal(a: number, b: number): number {",
        "  return helper() + a + b;",
        "}",
        "",
      ].join("\n"),
      "utf-8",
    );

    resetLoaderCounters();
    const payload = buildToolResponse("diff_impact", root, { scope: "working_tree" });
    expect(payload.state).not.toBe("falha");
    expect(Array.isArray(payload.changed_files)).toBe(true);
    expect((payload.changed_files as string[]).some((p) => p.includes("utils.ts"))).toBe(true);
    const changedSymbols = payload.changed_symbols as Array<{ name?: string; path?: string }> | undefined;
    expect(changedSymbols?.some((s) => s.name === "helper" && s.path?.includes("utils.ts"))).toBe(true);
    expect(getFullStructuralLoadCount()).toBe(0);
  });

  it("AC-5.2.1 parity: explore lazy preserva conteúdo vs índice full de referência", async () => {
    const root = setupFixture();
    expect(await runIndex()).toBe(0);

    // Referência full só no harness (não no hot path).
    const fullIndex = loadStructuralIndexForRead(root);
    expect(fullIndex).toBeTruthy();
    const refEntry = fullIndex!.files.find((f) =>
      f.symbols.some((s) => s.name === "calculateTotal"),
    );
    expect(refEntry).toBeTruthy();
    expect(refEntry!.symbols.find((s) => s.name === "calculateTotal")).toBeTruthy();

    const expectedCallers = fullIndex!.files.flatMap((file) =>
      file.edges
        .filter((edge) => edge.kind === "calls" && edge.to === "calculateTotal")
        .map(() => ({
          name: "calculateTotal",
          path: file.relative_path,
          kind: "calls",
          reason:
            file.relative_path === refEntry!.relative_path
              ? "same_file_call_match"
              : "cross_file_call_match",
        })),
    );
    const expectedImporters = fullIndex!.files
      .filter((file) =>
        file.imports.some((item) => item.resolved_path === refEntry!.relative_path),
      )
      .map((file) => file.relative_path);

    resetLoaderCounters();
    // detailed evita path-dictionary do concise e permite confrontar paths literais.
    const lazy = buildToolResponse("explore", root, {
      target: "calculateTotal",
      response_format: "detailed",
    });
    expect(getFullStructuralLoadCount()).toBe(0);
    expect(lazy.state).toBe("sucesso");

    const central = lazy.central_symbols as Array<{ name: string; path: string }>;
    expect(central.some((s) => s.name === "calculateTotal" && s.path === refEntry!.relative_path)).toBe(
      true,
    );

    const snippets = lazy.snippets as Array<{ body?: string; signature?: string }>;
    expect(snippets.some((s) => s.body?.includes("helper()") || s.body?.includes("return"))).toBe(true);

    const callers = lazy.callers as Array<{ path: string; name?: string; reason?: string }>;
    const callerKeys = new Set(callers.map((c) => `${c.path}:${c.name}:${c.reason}`));
    for (const expected of expectedCallers) {
      expect(callerKeys.has(`${expected.path}:${expected.name}:${expected.reason}`)).toBe(true);
    }

    const callees = lazy.callees as Array<{ name?: string }>;
    const refCallees = refEntry!.edges.filter((e) => e.kind === "calls").map((e) => e.to);
    for (const name of refCallees) {
      expect(callees.some((c) => c.name === name)).toBe(true);
    }

    const relevant = lazy.relevant_files as Array<{ path: string; reason?: string }>;
    for (const path of expectedImporters) {
      expect(relevant.some((r) => r.path === path && r.reason === "importer_file")).toBe(true);
    }
    expect((lazy.imports as unknown[]).length).toBe(refEntry!.imports.length);
  });

  it("AC-5.2.2 delta sync saudável não materializa índice anterior nem walk completo", async () => {
    const root = setupFixture(true);
    expect(await runIndex()).toBe(0);

    writeFileSync(join(root, "utils.ts"), "export function helper(): number { return 9; }\n", "utf-8");
    writeFileSync(join(root, "extra.ts"), "export const extra = 1;\n", "utf-8");

    resetLoaderCounters();
    resetDiscoverWalkCount();
    expect(await runSync({ since: "HEAD" })).toBe(0);

    expect(getFullStructuralLoadCount()).toBe(0);
    expect(getDiscoverWalkCount()).toBe(0);

    const index = loadStructuralIndexForRead(root);
    expect(index?.files.map((f) => f.relative_path).sort()).toEqual(["dep.ts", "extra.ts", "utils.ts"]);
    expect(
      index?.files.find((f) => f.relative_path === "utils.ts")?.symbols.some((s) => s.name === "helper"),
    ).toBe(true);
  });

  it("AC-5.2.3 dirty-flag corrompida cai em fallback honesto e recuperável", async () => {
    const root = setupFixture(true);
    expect(await runIndex()).toBe(0);
    markDirty(["utils.ts"], { sinceRef: "HEAD", cwd: root });
    writeFileSync(join(root, ".argus", "dirty.json"), "{ not-json", "utf-8");
    expect(readDirtyFlag(root)).toBeNull();

    writeFileSync(join(root, "new.ts"), "export const neu = true;\n", "utf-8");
    resetDiscoverWalkCount();
    expect(await runSync()).toBe(0);
    // Sem dirty válida → walk completo honesto.
    expect(getDiscoverWalkCount()).toBeGreaterThan(0);

    const index = loadStructuralIndexForRead(root);
    expect(index?.files.map((f) => f.relative_path)).toContain("new.ts");
  });
});
