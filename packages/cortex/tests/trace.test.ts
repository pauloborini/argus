import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runIndex } from "../src/commands/index-cmd.js";
import { buildToolStub } from "../src/mcp/tools/stubs.js";
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
    tempDir = mkdtempSync(join(tmpdir(), "cortex-trace-"));
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

    const payload = buildToolStub("trace", root, {
      from: "calculateTotal",
      to: "helper",
      direction: "forward",
      max_hops: 4,
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

    const payload = buildToolStub("trace", root, {
      from: "src/main.ts",
      to: "src/dep.ts",
      max_hops: 3,
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

    const payload = buildToolStub("trace", root, { from: "run" });
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

    const payload = buildToolStub("trace", root, {
      from: "boot",
      to: "src/right.ts",
      max_hops: 4,
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

    const payload = buildToolStub("trace", root, {
      from: "src/main.ts",
      to: "src/dep.ts",
      max_hops: 3,
    });
    expect(payload.state).toBe("stale");
    expect(String(payload.staleness_hint)).toContain("cortex sync");
  });

  it("trace degrada para parcial em Dart por cobertura limitada", async () => {
    const root = setupWorkspace({
      "lib/main.dart": 'import "dep.dart";\nvoid boot() { helper(); }\n',
      "lib/dep.dart": "void helper() {}\n",
    });
    expect(await runIndex()).toBe(0);

    const payload = buildToolStub("trace", root, {
      from: "lib/main.dart",
      to: "lib/dep.dart",
      max_hops: 3,
    });
    expect(payload.state).toBe("parcial");
    expect(((payload.limitations as string[] | undefined) ?? []).length).toBeGreaterThan(0);
  });
});
