import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runIndex } from "../src/commands/index-cmd.js";
import { buildToolStub } from "../src/mcp/tools/stubs.js";
import { initWorkspace } from "../src/workspace/workspace.js";

describe("search tool", () => {
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
    tempDir = mkdtempSync(join(tmpdir(), "cortex-search-"));
    for (const [relativePath, content] of Object.entries(files)) {
      const absolutePath = join(tempDir, relativePath);
      mkdirSync(dirname(absolutePath), { recursive: true });
      writeFileSync(absolutePath, content, "utf-8");
    }
    initWorkspace(tempDir);
    process.chdir(tempDir);
    return tempDir;
  }

  it("retorna candidatos FTS em índice fresh", async () => {
    const root = setupWorkspace({
      "app.ts": "export function calculateTotal() { return 1; }\n",
    });
    expect(await runIndex()).toBe(0);

    const payload = buildToolStub("search", root, { query: "calculateTotal" });
    expect(payload.state).toBe("sucesso");
    const candidates = payload.candidates as Array<{ name: string; path: string }>;
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0]?.name).toBe("calculateTotal");
    expect(candidates[0]?.path).toBe("app.ts");
  });

  it("declara ambiguidade quando há símbolos equivalentes", async () => {
    const root = setupWorkspace({
      "a.ts": "export function run() { return 1; }\n",
      "b.ts": "export function run() { return 2; }\n",
    });
    expect(await runIndex()).toBe(0);

    const payload = buildToolStub("search", root, { query: "run" });
    expect(payload.state).toBe("ambigua");
    const candidates = payload.candidates as Array<{ path: string }>;
    expect(candidates).toHaveLength(2);
  });

  it("expõe start_line e distingue símbolos homônimos no mesmo arquivo", async () => {
    const root = setupWorkspace({
      "dup.ts":
        "export function compress() { return 1; }\n\nexport const x = 1;\n\nexport function compress2() { return 2; }\nexport function compress() { return 3; }\n",
    });
    expect(await runIndex()).toBe(0);

    const payload = buildToolStub("search", root, { query: "compress", kind: "function" });
    const candidates = payload.candidates as Array<{ name: string; path: string; start_line: number }>;
    const homonyms = candidates.filter((c) => c.name === "compress" && c.path === "dup.ts");
    expect(homonyms.length).toBe(2);
    expect(homonyms[0]!.start_line).toBeGreaterThan(0);
    expect(homonyms[1]!.start_line).toBeGreaterThan(0);
    expect(homonyms[0]!.start_line).not.toBe(homonyms[1]!.start_line);
    // tiebreak determinístico por linha
    expect(homonyms[0]!.start_line).toBeLessThan(homonyms[1]!.start_line);
  });

  it("rankeia prefixo e respeita scope/kind", async () => {
    const root = setupWorkspace({
      "src/billing.ts": "export function calculateTotal() { return 1; }\n",
      "tests/billing.test.ts": "export function calculateFixture() { return 2; }\n",
    });
    expect(await runIndex()).toBe(0);

    const payload = buildToolStub("search", root, {
      query: "calculate",
      scope: "src/",
      kind: "function",
    });
    const candidates = payload.candidates as Array<{
      name: string;
      path: string;
      score: number;
      match_reason: string;
    }>;
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      name: "calculateTotal",
      path: "src/billing.ts",
      match_reason: "name_prefix",
    });
    expect(candidates[0]!.score).toBeGreaterThan(0.8);
  });

  it("aplica scope antes do limite bruto", async () => {
    const files = Object.fromEntries(
      Array.from({ length: 8 }, (_, index) => [
        `src/a${index}.ts`,
        `export function calculateA${index}() { return ${index}; }\n`,
      ]),
    );
    files["target/wanted.ts"] = "export function calculateWanted() { return 1; }\n";
    const root = setupWorkspace(files);
    expect(await runIndex()).toBe(0);

    const payload = buildToolStub("search", root, {
      query: "calculate",
      scope: "target/",
      kind: "function",
      limit: 1,
    });
    expect(payload.candidates).toEqual([
      expect.objectContaining({ name: "calculateWanted", path: "target/wanted.ts" }),
    ]);
  });

  it("propaga stale com candidatos do índice atual", async () => {
    const root = setupWorkspace({
      "app.ts": "export function calculateTotal() { return 1; }\n",
    });
    expect(await runIndex()).toBe(0);
    writeFileSync(join(root, "app.ts"), "export function calculateTotal() { return 2; }\n", "utf-8");

    const payload = buildToolStub("search", root, { query: "calculateTotal" });
    expect(payload.state).toBe("stale");
    expect((payload.candidates as unknown[]).length).toBeGreaterThan(0);
    expect(String(payload.staleness_hint)).toContain("cortex sync");
  });

  it("um arquivo grande não quebra search (MAX_FILE_SIZE é exclusão simétrica)", async () => {
    // Regressão do bug que zerava search em repos reais: um único arquivo
    // acima de MAX_FILE_SIZE (lockfile, código gerado, asset) não pode
    // poluir staleness nem suprimir candidatos. O índice continua válido.
    const root = setupWorkspace({
      "app.ts": "export function calculateTotal() { return 1; }\n",
      "assets/blob.bin": "x".repeat(2 * 1024 * 1024 + 1),
    });
    expect(await runIndex()).toBe(0);

    const payload = buildToolStub("search", root, { query: "calculateTotal" });
    expect(payload.state).toBe("sucesso");
    const candidates = payload.candidates as Array<{ name: string; path: string }>;
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0]?.name).toBe("calculateTotal");
  });

  it("degrada para parcial quando o match está em linguagem com cobertura parcial", async () => {
    const root = setupWorkspace({
      "lib/feature.dart": "class FeatureController { void run() {} }\n",
    });
    expect(await runIndex()).toBe(0);

    const payload = buildToolStub("search", root, { query: "FeatureController" });
    expect(payload.state).toBe("parcial");
    expect((payload.candidates as Array<{ path: string }>)[0]?.path).toBe("lib/feature.dart");
    expect((payload.limitations as string[]).some((item) => item.includes("Cobertura parcial"))).toBe(true);
  });
});
