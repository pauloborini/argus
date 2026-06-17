import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runIndex } from "../src/commands/index-cmd.js";
import { buildToolResponse } from "../src/mcp/tools/response.js";
import { initWorkspace } from "../src/workspace/workspace.js";

describe("explore tool", () => {
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
    tempDir = mkdtempSync(join(tmpdir(), "cortex-explore-"));
    for (const [relativePath, content] of Object.entries(files)) {
      const absolutePath = join(tempDir, relativePath);
      mkdirSync(dirname(absolutePath), { recursive: true });
      writeFileSync(absolutePath, content, "utf-8");
    }
    initWorkspace(tempDir);
    process.chdir(tempDir);
    return tempDir;
  }

  it("explora símbolo com contexto do arquivo", async () => {
    const root = setupWorkspace({
      "utils.ts": 'import { helper } from "./dep";\nexport function calculateTotal() { helper(); return 1; }\n',
      "dep.ts": "export function helper() {}\n",
    });
    expect(await runIndex()).toBe(0);

    const payload = buildToolResponse("explore", root, { target: "calculateTotal", mode: "symbol" });
    expect(payload.state).toBe("sucesso");
    expect(String(payload.summary)).toContain("calculateTotal");
    expect((payload.central_symbols as Array<{ name: string }>)[0]?.name).toBe("calculateTotal");
    expect((payload.relevant_files as Array<{ path: string }>).some((item) => item.path === "dep.ts")).toBe(true);
    expect((payload.snippets as Array<{ path: string }>)[0]?.path).toBe("utils.ts");
  });

  it("overview-first: central_symbols e snippets carregam signature sem corpo", async () => {
    const root = setupWorkspace({
      "utils.ts": 'import { helper } from "./dep";\nexport function calculateTotal() { helper(); return 1; }\n',
      "dep.ts": "export function helper() {}\n",
    });
    expect(await runIndex()).toBe(0);

    const payload = buildToolResponse("explore", root, { target: "calculateTotal", mode: "symbol" });
    const central = (payload.central_symbols as Array<{ name: string; signature?: string }>)[0];
    expect(central?.signature).toContain("calculateTotal");
    expect(central?.signature).not.toContain("return 1");
    const snippet = (payload.snippets as Array<{ signature?: string }>)[0];
    expect(snippet?.signature).toContain("calculateTotal");
  });

  it("declara ambiguidade quando múltiplos alvos competem", async () => {
    const root = setupWorkspace({
      "a.ts": "export function run() {}\n",
      "b.ts": "export function run() {}\n",
    });
    expect(await runIndex()).toBe(0);

    const payload = buildToolResponse("explore", root, { target: "run", mode: "symbol" });
    expect(payload.state).toBe("ambigua");
    expect((payload.candidates as unknown[]).length).toBe(2);
  });

  it("explora arquivo por path", async () => {
    const root = setupWorkspace({
      "feature/main.ts": "export class MainFeature {}\nexport function boot() {}\n",
    });
    expect(await runIndex()).toBe(0);

    const payload = buildToolResponse("explore", root, { target: "feature/main.ts", mode: "file" });
    expect(payload.state).toBe("sucesso");
    expect((payload.central_symbols as Array<{ name: string }>).length).toBeGreaterThan(0);
    expect(String(payload.summary)).toContain("feature/main.ts");
  });

  it("propaga stale quando o arquivo muda após index", async () => {
    const root = setupWorkspace({
      "utils.ts": 'export function calculateTotal() { return 1; }\n',
    });
    expect(await runIndex()).toBe(0);
    writeFileSync(join(root, "utils.ts"), 'export function calculateTotal() { return 2; }\n', "utf-8");

    const payload = buildToolResponse("explore", root, {
      target: "calculateTotal",
      mode: "symbol",
      response_format: "detailed",
    });
    expect(payload.state).toBe("stale");
    expect(String(payload.staleness_hint)).toContain("cortex sync");
  });

  it("Dart full: explore retorna sucesso (cobertura full, S31)", async () => {
    const root = setupWorkspace({
      "lib/main.dart": "class MainFeature {}\nvoid boot() {}\n",
    });
    expect(await runIndex()).toBe(0);

    const payload = buildToolResponse("explore", root, {
      target: "lib/main.dart",
      mode: "file",
      response_format: "detailed",
    });
    expect(payload.state).toBe("sucesso");
    // Dart full: não deve declarar limitação de cobertura de linguagem
    expect(
      (payload.limitations as string[] | undefined)?.some((item) =>
        item.toLowerCase().includes("dart"),
      ) ?? false,
    ).toBe(false);
  });

});
