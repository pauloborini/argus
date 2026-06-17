import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runIndex } from "../src/commands/index-cmd.js";
import { buildToolStub } from "../src/mcp/tools/stubs.js";
import { initWorkspace } from "../src/workspace/workspace.js";

describe("diff impact tool", () => {
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
    tempDir = mkdtempSync(join(tmpdir(), "cortex-diff-impact-"));
    for (const [relativePath, content] of Object.entries(files)) {
      const absolutePath = join(tempDir, relativePath);
      mkdirSync(dirname(absolutePath), { recursive: true });
      writeFileSync(absolutePath, content, "utf-8");
    }
    execFileSync("git", ["init"], { cwd: tempDir, encoding: "utf-8" });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: tempDir, encoding: "utf-8" });
    execFileSync("git", ["config", "user.name", "Test User"], { cwd: tempDir, encoding: "utf-8" });
    execFileSync("git", ["add", "."], { cwd: tempDir, encoding: "utf-8" });
    execFileSync("git", ["commit", "-m", "baseline"], { cwd: tempDir, encoding: "utf-8" });
    initWorkspace(tempDir);
    process.chdir(tempDir);
    return tempDir;
  }

  it("diff-impact unstaged retorna arquivos alterados e testes afetados", async () => {
    const root = setupWorkspace({
      "src/dep.ts": "export function helper() {}\n",
      "src/main.ts": 'import { helper } from "./dep";\nexport function boot() { helper(); }\n',
      "tests/main.test.ts": 'import { boot } from "../src/main";\nboot();\n',
    });
    writeFileSync(join(root, "src/dep.ts"), "export function helper() { return 1; }\n", "utf-8");
    expect(await runIndex()).toBe(0);

    const payload = buildToolStub("diff_impact", root, { scope: "unstaged" });
    expect(["sucesso", "parcial", "stale"]).toContain(payload.state);
    expect(payload.changed_files).toContain("src/dep.ts");
    expect((payload.affected_tests as string[]).some((item) => item.endsWith("main.test.ts"))).toBe(true);
    expect((payload.changed_symbols as Array<{ name: string }>).some((item) => item.name === "helper")).toBe(true);
  });

  it("diff-impact limita símbolos aos hunks alterados", async () => {
    const root = setupWorkspace({
      "src/multi.ts":
        "export function first() { return 1; }\n\nexport function second() { return 2; }\n",
    });
    expect(await runIndex()).toBe(0);

    writeFileSync(
      join(root, "src/multi.ts"),
      "export function first() { return 10; }\n\nexport function second() { return 2; }\n",
      "utf-8",
    );
    const payload = buildToolStub("diff_impact", root, { scope: "unstaged" });
    const symbols = payload.changed_symbols as Array<{ name: string }>;
    expect(symbols.map((item) => item.name)).toContain("first");
    expect(symbols.map((item) => item.name)).not.toContain("second");
    expect((payload.changed_hunks as unknown[]).length).toBeGreaterThan(0);
  });

  it("diff-impact preserva hunk e símbolo de arquivo removido", async () => {
    const root = setupWorkspace({
      "src/removed.ts": "export function removed() { return 1; }\n",
    });
    expect(await runIndex()).toBe(0);
    rmSync(join(root, "src/removed.ts"));

    const payload = buildToolStub("diff_impact", root, { scope: "unstaged" });
    expect(payload.changed_hunks).toEqual([
      expect.objectContaining({ path: "src/removed.ts", start_line: 1, line_count: 1 }),
    ]);
    expect(payload.changed_symbols).toEqual([
      expect.objectContaining({ name: "removed", path: "src/removed.ts" }),
    ]);
  });

  it("diff-impact staged lê diff cached", async () => {
    const root = setupWorkspace({
      "src/dep.ts": "export function helper() {}\n",
      "src/main.ts": 'import { helper } from "./dep";\nexport function boot() { helper(); }\n',
    });
    writeFileSync(
      join(root, "src/main.ts"),
      'import { helper } from "./dep";\nexport function boot() { return helper(); }\n',
      "utf-8",
    );
    execFileSync("git", ["add", "src/main.ts"], { cwd: root, encoding: "utf-8" });
    expect(await runIndex()).toBe(0);

    const payload = buildToolStub("diff_impact", root, { scope: "staged" });
    expect(["sucesso", "parcial", "stale"]).toContain(payload.state);
    expect(payload.changed_files).toContain("src/main.ts");
  });

  it("diff-impact compare exige base_ref", async () => {
    const root = setupWorkspace({
      "src/app.ts": "export function app() {}\n",
    });
    expect(await runIndex()).toBe(0);

    const payload = buildToolStub("diff_impact", root, { scope: "compare" });
    expect(payload.state).toBe("falha");
    expect(String(payload.message)).toContain("E_BASE_REF_REQUIRED");
  });

  it("diff-impact propaga stale quando há diff sobre índice desatualizado", async () => {
    const root = setupWorkspace({
      "src/dep.ts": "export function helper() {}\n",
      "src/main.ts": 'import { helper } from "./dep";\nexport function boot() { helper(); }\n',
    });
    expect(await runIndex()).toBe(0);
    writeFileSync(join(root, "src/dep.ts"), "export function helper() { return 1; }\n", "utf-8");

    const payload = buildToolStub("diff_impact", root, {
      scope: "unstaged",
      response_format: "detailed",
    });
    expect(payload.state).toBe("stale");
    expect(String(payload.staleness_hint)).toContain("cortex sync");
  });

  it("diff-impact degrada para parcial em Dart por cobertura limitada", async () => {
    const root = setupWorkspace({
      "lib/dep.dart": "void helper() {}\n",
      "lib/main.dart": 'import "dep.dart";\nvoid boot() { helper(); }\n',
      "test/main_test.dart": 'import "../lib/main.dart";\nvoid main() { boot(); }\n',
    });
    writeFileSync(join(root, "lib/dep.dart"), "void helper() { print(1); }\n", "utf-8");
    expect(await runIndex()).toBe(0);

    const payload = buildToolStub("diff_impact", root, {
      scope: "unstaged",
      response_format: "detailed",
    });
    expect(payload.state).toBe("parcial");
    expect((payload.limitations as string[]).some((item) => item.includes("Cobertura parcial"))).toBe(true);
  });
});
