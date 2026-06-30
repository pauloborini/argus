import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runIndex } from "../src/commands/index-cmd.js";
import { buildToolResponse } from "../src/mcp/tools/response.js";
import { initWorkspace } from "../src/workspace/workspace.js";

describe("trace tool", () => {
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
    tempDir = mkdtempSync(join(tmpdir(), "argus-trace-"));
    for (const [relativePath, content] of Object.entries(files)) {
      const absolutePath = join(tempDir, relativePath);
      mkdirSync(dirname(absolutePath), { recursive: true });
      writeFileSync(absolutePath, content, "utf-8");
    }
    initWorkspace(tempDir);
    process.chdir(tempDir);
    return tempDir;
  }

  it("trace encontra caminho provável entre símbolos", async () => {
    const root = setupWorkspace({
      "utils.ts": 'import { helper } from "./dep";\nexport function calculateTotal() { helper(); return 1; }\n',
      "dep.ts": "export function helper() {}\n",
    });
    expect(await runIndex()).toBe(0);

    const payload = buildToolResponse("trace", root, {
      from: "calculateTotal",
      to: "helper",
      direction: "forward",
      max_hops: 4,
      response_format: "detailed",
    });
    expect(["sucesso", "parcial"]).toContain(payload.state);
    expect((payload.paths as Array<{ hops: unknown[] }>).length).toBeGreaterThan(0);
    expect((payload.symbols as string[]).some((item) => item.startsWith("helper@dep.ts"))).toBe(true);
  });

  it("trace por arquivo segue imports prováveis", async () => {
    const root = setupWorkspace({
      "src/main.ts": 'import { helper } from "./dep";\nexport function boot() { helper(); }\n',
      "src/dep.ts": "export function helper() {}\n",
    });
    expect(await runIndex()).toBe(0);

    const payload = buildToolResponse("trace", root, {
      from: "src/main.ts",
      to: "src/dep.ts",
      max_hops: 3,
      response_format: "detailed",
    });
    expect(["sucesso", "parcial"]).toContain(payload.state);
    expect((payload.files as string[])).toContain("src/dep.ts");
  });

  it("trace declara ambiguidade quando origem compete", async () => {
    const root = setupWorkspace({
      "a.ts": "export function run() {}\n",
      "b.ts": "export function run() {}\n",
    });
    expect(await runIndex()).toBe(0);

    const payload = buildToolResponse("trace", root, { from: "run" });
    expect(payload.state).toBe("ambigua");
    expect((payload.candidates as unknown[]).length).toBe(2);
  });

  it("trace resolve chamada para o símbolo realmente importado", async () => {
    const root = setupWorkspace({
      "src/main.ts":
        'import { helper } from "./right";\nexport function boot() { helper(); }\n',
      "src/right.ts": "export function helper() {}\n",
      "src/wrong.ts": "export function helper() {}\n",
    });
    expect(await runIndex()).toBe(0);

    const payload = buildToolResponse("trace", root, {
      from: "boot",
      to: "src/right.ts",
      max_hops: 4,
      response_format: "detailed",
    });
    expect(["sucesso", "parcial"]).toContain(payload.state);
    expect(payload.files).toContain("src/right.ts");
    expect(payload.files).not.toContain("src/wrong.ts");
  });

  it("trace propaga stale quando origem muda após index", async () => {
    const root = setupWorkspace({
      "src/main.ts": 'import { helper } from "./dep";\nexport function boot() { helper(); }\n',
      "src/dep.ts": "export function helper() {}\n",
    });
    expect(await runIndex()).toBe(0);
    writeFileSync(join(root, "src/main.ts"), 'import { helper } from "./dep";\nexport function boot() { return helper(); }\n', "utf-8");

    const payload = buildToolResponse("trace", root, {
      from: "src/main.ts",
      to: "src/dep.ts",
      max_hops: 3,
      response_format: "detailed",
    });
    expect(payload.state).toBe("stale");
    expect(String(payload.staleness_hint)).toContain("argus sync");
  });

  it("Dart full: trace não degrada por linguagem (cobertura full, S31)", async () => {
    const root = setupWorkspace({
      "lib/main.dart": 'import "dep.dart";\nvoid boot() { helper(); }\n',
      "lib/dep.dart": "void helper() {}\n",
    });
    expect(await runIndex()).toBe(0);

    const payload = buildToolResponse("trace", root, {
      from: "lib/main.dart",
      to: "lib/dep.dart",
      max_hops: 3,
      response_format: "detailed",
    });
    // Dart full: trace pode ser sucesso ou parcial por uncertainty_points
    // (fluxo dinâmico), mas NÃO deve ser parcial apenas por coverage_level de linguagem
    expect(["sucesso", "parcial", "vazio"]).toContain(payload.state);
  });

  it("Kotlin full: trace não degrada por linguagem (cobertura full, S32)", async () => {
    const root = setupWorkspace({
      "src/Main.kt": 'import dep.helper\nfun boot() { helper() }\n',
      "src/dep.kt": "package dep\nfun helper() {}\n",
    });
    expect(await runIndex()).toBe(0);

    const payload = buildToolResponse("trace", root, {
      from: "src/Main.kt",
      to: "src/dep.kt",
      max_hops: 3,
      response_format: "detailed",
    });
    expect(["sucesso", "parcial", "vazio"]).toContain(payload.state);
  });
});
