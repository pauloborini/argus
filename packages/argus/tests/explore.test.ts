import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runIndex } from "../src/commands/index-cmd.js";
import { buildToolResponse } from "../src/mcp/tools/response.js";
import { VaultEngine } from "../src/memory/vault-engine.js";
import { initWorkspace } from "../src/workspace/workspace.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const TRUNCATE_STRESS_FIXTURE = join(HERE, "fixtures/explore-truncate-stress/large-symbol.ts");
const HARDENING_NEEDLE = "HARDENING_NEEDLE_BEYOND_CAP_16";

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
    tempDir = mkdtempSync(join(tmpdir(), "argus-explore-"));
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

  it("balanced acionável: snippets carregam body verbatim além da assinatura (S3)", async () => {
    const root = setupWorkspace({
      "utils.ts": 'import { helper } from "./dep";\nexport function calculateTotal() { helper(); return 1; }\n',
      "dep.ts": "export function helper() {}\n",
    });
    expect(await runIndex()).toBe(0);

    const payload = buildToolResponse("explore", root, { target: "calculateTotal", mode: "symbol" });
    const central = (payload.central_symbols as Array<{ name: string; signature?: string }>)[0];
    expect(central?.signature).toContain("calculateTotal");
    // Assinatura em central_symbols permanece sem corpo; o trecho verbatim vai em snippets.body.
    expect(central?.signature).not.toContain("return 1");
    const snippet = (payload.snippets as Array<{ signature?: string; body?: string }>)[0];
    expect(snippet?.signature).toContain("calculateTotal");
    expect(snippet?.body).toBeTruthy();
    expect(snippet?.body).toContain("return 1");
    expect(snippet?.body).toContain("helper()");
  });

  it("concise preserva snippet.body, refs e códigos acionáveis (AC-3.2.2)", async () => {
    const root = setupWorkspace({
      "utils.ts": "export function calculateTotal() { return 1; }\n",
    });
    expect(await runIndex()).toBe(0);

    const payload = buildToolResponse("explore", root, { target: "calculateTotal", mode: "symbol" });
    expect(payload.confidence).toBeUndefined();
    expect(payload.limitations).toBeUndefined();
    const snippet = (payload.snippets as Array<{ body?: string; signature?: string; path?: string }>)[0];
    expect(snippet?.body).toContain("return 1");
    expect(snippet?.signature).toContain("calculateTotal");
    expect(snippet?.path).toBe("utils.ts");
    expect((payload.relevant_files as unknown[]).length).toBeGreaterThan(0);
    expect((payload.central_symbols as unknown[]).length).toBeGreaterThan(0);
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
    expect(String(payload.staleness_hint)).toContain("argus sync");
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

  it("Kotlin full: explore retorna sucesso (cobertura full, S32)", async () => {
    const root = setupWorkspace({
      "src/Main.kt": "class MainFeature {}\nfun boot() {}\n",
    });
    expect(await runIndex()).toBe(0);

    const payload = buildToolResponse("explore", root, {
      target: "src/Main.kt",
      mode: "file",
      response_format: "detailed",
    });
    expect(payload.state).toBe("sucesso");
    expect(
      (payload.limitations as string[] | undefined)?.some((item) =>
        item.toLowerCase().includes("kotlin"),
      ) ?? false,
    ).toBe(false);
  });

  it("memory_refs usa fallback FTS com mechanism e sinais v2 quando grafo vazio (S05)", async () => {
    const root = setupWorkspace({
      "utils.ts": "export function calculateTotal() { return 1; }\n",
    });
    expect(await runIndex()).toBe(0);
    VaultEngine.init(root);
    const vault = join(root, ".argus", "memory", "vault", "reference");
    mkdirSync(vault, { recursive: true });
    writeFileSync(
      join(vault, "note-calc.md"),
      [
        "---",
        'title: "Calc note"',
        "type: reference",
        "scope: project",
        "source: direct_capture",
        "confidence: inferred",
        "observed_at: 2026-01-01T00:00:00.000Z",
        'stale_reason: "session_expired"',
        "---",
        "",
        "calculateTotal memory reference",
        "",
      ].join("\n"),
      "utf-8",
    );
    expect(VaultEngine.sync(root).state).toBe("sucesso");

    const payload = buildToolResponse("explore", root, {
      target: "calculateTotal",
      mode: "symbol",
      response_format: "detailed",
    });
    expect(payload.state).toBe("sucesso");
    const refs = payload.memory_refs as Array<{
      mechanism?: string;
      confidence?: string;
      evidence?: string;
    }>;
    expect(refs.length).toBeGreaterThan(0);
    expect(refs[0]?.mechanism).toBe("fts-only");
    expect(refs[0]?.confidence).toBe("inferred");
    expect(refs[0]?.evidence).toBe("session_expired");
  });

  it("H1: símbolo > caps balanced emite retrieve_handle e retrieve devolve needle além da janela (AC-1.2.*)", async () => {
    const source = readFileSync(TRUNCATE_STRESS_FIXTURE, "utf-8");
    const root = setupWorkspace({
      "large-symbol.ts": source,
    });
    expect(await runIndex()).toBe(0);

    const explore = buildToolResponse("explore", root, {
      target: "largeHardeningSymbol",
      mode: "symbol",
      response_format: "detailed",
    });
    const snippets = (explore.snippets as Array<{ truncated?: boolean; body?: string }>) ?? [];
    expect(snippets.some((s) => s.truncated === true)).toBe(true);
    expect(snippets.some((s) => (s.body ?? "").includes(HARDENING_NEEDLE))).toBe(false);
    expect(typeof explore.retrieve_handle).toBe("string");
    expect(String(explore.retrieve_handle)).toMatch(/^rh_[a-f0-9]{16}$/);

    const next = String(explore.suggested_next_action ?? "").toLowerCase();
    expect(next).toMatch(/retrieve|pack_context/);
    expect(next).not.toMatch(/\btrace\b/);
    expect(next).not.toMatch(/\bimpact\b/);
    expect(next).not.toMatch(/\bsearch\b/);

    const retrieved = buildToolResponse("retrieve", root, {
      handle: String(explore.retrieve_handle),
    });
    expect(["sucesso", "parcial"]).toContain(retrieved.state);
    expect(String(retrieved.content)).toContain(HARDENING_NEEDLE);
  });

  it("suggested_next_action no sucesso sem truncamento não empurra menu avançado (AC-1.2.3)", async () => {
    const root = setupWorkspace({
      "utils.ts": "export function calculateTotal() { return 1; }\n",
    });
    expect(await runIndex()).toBe(0);

    const payload = buildToolResponse("explore", root, {
      target: "calculateTotal",
      mode: "symbol",
    });
    expect(payload.retrieve_handle).toBeUndefined();
    const next = String(payload.suggested_next_action ?? "").toLowerCase();
    expect(next).toContain("pack_context");
    expect(next).not.toMatch(/\btrace\b/);
    expect(next).not.toMatch(/\bimpact\b/);
    expect(next).not.toMatch(/\bsearch\b/);
  });

});
