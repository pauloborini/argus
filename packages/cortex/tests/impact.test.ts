import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runIndex } from "../src/commands/index-cmd.js";
import { buildToolStub, personalizedPageRank } from "../src/mcp/tools/stubs.js";
import { initWorkspace } from "../src/workspace/workspace.js";

describe("impact tool", () => {
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

  function setupWorkspace(files: Record<string, string>): string {
    originalCwd = process.cwd();
    tempDir = mkdtempSync(join(tmpdir(), "cortex-impact-"));
    for (const [relativePath, content] of Object.entries(files)) {
      const absolutePath = join(tempDir, relativePath);
      mkdirSync(dirname(absolutePath), { recursive: true });
      writeFileSync(absolutePath, content, "utf-8");
    }
    initWorkspace(tempDir);
    process.chdir(tempDir);
    return tempDir;
  }

  it("PageRank distribui massa proporcionalmente ao peso da edge", () => {
    const node = (id: string) => ({ id, node_type: "symbol" as const, name: id, path: `${id}.ts` });
    const seed = node("seed");
    const low = node("low");
    const high = node("high");
    const adjacency = new Map([
      [seed.id, [
        { relation: "calls", from: seed, to: low, weight: 1 },
        { relation: "calls", from: seed, to: high, weight: 10 },
      ]],
    ]);

    const rank = personalizedPageRank(adjacency, [seed.id]);
    expect(rank.get(high.id)).toBeGreaterThan(rank.get(low.id) ?? 0);
  });

  it("impact dependencies retorna blast radius por símbolo", async () => {
    const root = setupWorkspace({
      "utils.ts": 'import { helper } from "./dep";\nexport function calculateTotal() { helper(); return 1; }\n',
      "dep.ts": "export function helper() {}\n",
    });
    expect(await runIndex()).toBe(0);

    const payload = buildToolStub("impact", root, {
      target: "calculateTotal",
      direction: "dependencies",
      depth: 2,
    });
    expect(["sucesso", "parcial"]).toContain(payload.state);
    expect((payload.files as string[])).toContain("dep.ts");
    expect(String(payload.risk_summary)).toContain("afetado");
  });

  it("impact dependents encontra arquivos consumidores", async () => {
    const root = setupWorkspace({
      "src/main.ts": 'import { helper } from "./dep";\nexport function boot() { helper(); }\n',
      "src/dep.ts": "export function helper() {}\n",
    });
    expect(await runIndex()).toBe(0);

    const payload = buildToolStub("impact", root, {
      target: "src/dep.ts",
      direction: "dependents",
      depth: 2,
    });
    expect(["sucesso", "parcial"]).toContain(payload.state);
    expect((payload.files as string[])).toContain("src/main.ts");
  });

  it("impact declara ambiguidade quando alvo compete", async () => {
    const root = setupWorkspace({
      "a.ts": "export function run() {}\n",
      "b.ts": "export function run() {}\n",
    });
    expect(await runIndex()).toBe(0);

    const payload = buildToolStub("impact", root, { target: "run" });
    expect(payload.state).toBe("ambigua");
    expect((payload.candidates as unknown[]).length).toBe(2);
  });

  it("impact propaga stale quando o arquivo muda após index", async () => {
    const root = setupWorkspace({
      "src/main.ts": 'import { helper } from "./dep";\nexport function boot() { helper(); }\n',
      "src/dep.ts": "export function helper() {}\n",
    });
    expect(await runIndex()).toBe(0);
    writeFileSync(join(root, "src/dep.ts"), "export function helper() { return 1; }\n", "utf-8");

    const payload = buildToolStub("impact", root, {
      target: "src/dep.ts",
      direction: "dependents",
      depth: 2,
      response_format: "detailed",
    });
    expect(payload.state).toBe("stale");
    expect(String(payload.staleness_hint)).toContain("cortex sync");
  });

  it("impact degrada para parcial em Dart por cobertura limitada", async () => {
    const root = setupWorkspace({
      "lib/main.dart": 'import "dep.dart";\nvoid boot() { helper(); }\n',
      "lib/dep.dart": "void helper() {}\n",
    });
    expect(await runIndex()).toBe(0);

    const payload = buildToolStub("impact", root, {
      target: "lib/dep.dart",
      direction: "dependents",
      depth: 2,
      response_format: "detailed",
    });
    expect(payload.state).toBe("parcial");
    expect((payload.limitations as string[]).some((item) => item.includes("Cobertura parcial"))).toBe(true);
  });
});
