import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runIndex } from "../src/commands/index-cmd.js";
import { VaultEngine } from "../src/memory/vault-engine.js";
import { writeMemoryConfig } from "../src/memory/config.js";
import { LlmProviderError } from "../src/memory/llm-provider.js";
import { MCP_TOOL_NAMES } from "../src/mcp/tool-registry.js";
import { openIndexDb } from "../src/storage/sqlite-index-store.js";
import { buildToolResponse, buildToolResponseAsync } from "../src/mcp/tools/response.js";
import { getIndexDbPath, initWorkspace } from "../src/workspace/workspace.js";

describe("pack context tool", () => {
  let tempDir: string | undefined;
  let originalCwd: string | undefined;

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
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
    tempDir = mkdtempSync(join(tmpdir(), "argus-pack-context-"));
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

    const payload = buildToolResponse("pack_context", root, {
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

  it("AC-3.1.2 pack balanced com budget apertado preserva trecho útil e emite handle", async () => {
    const root = setupWorkspace();
    expect(await runIndex()).toBe(0);

    const payload = buildToolResponse("pack_context", root, {
      sources: ["utils.ts"],
      goal: "entender refactor com contexto estrutural",
      token_budget: 90,
      style: "balanced",
      response_format: "detailed",
    });
    expect(["parcial", "stale"]).toContain(payload.state);
    expect(typeof payload.retrieve_handle).toBe("string");
    expect(String(payload.retrieve_handle)).toMatch(/^rh_[a-f0-9]{16}$/);
    // Trecho útil = corpo verbatim + bloco Snippet, não só scaffolding Fonte:/Fontes:.
    const packed = String(payload.packed_context);
    expect(packed).toContain("return 1");
    expect(packed).toMatch(/Snippet utils\.ts:/);
    expect(packed).toContain("calculateTotal");
    expect(payload.reversibility).toBe("full");
  });

  it("balanced acionável: empacota trecho verbatim e respeita budget (S3)", async () => {
    const root = setupWorkspace();
    expect(await runIndex()).toBe(0);

    const payload = buildToolResponse("pack_context", root, {
      sources: ["utils.ts"],
      goal: "entender refactor",
      token_budget: 400,
      style: "balanced",
    });
    const packed = String(payload.packed_context);
    expect(packed).toContain("calculateTotal");
    // Balanced agora inclui corpo mínimo acionável (D4).
    expect(packed).toContain("return 1");
    expect(packed).toMatch(/Snippet utils\.ts:/);
    expect((payload.origin_refs as unknown[]).length).toBeGreaterThan(0);
  });

  it("brief continua sem corpo; deep preserva conteúdo ampliado (AC-3.1.3)", async () => {
    const root = setupWorkspace();
    expect(await runIndex()).toBe(0);

    const brief = buildToolResponse("pack_context", root, {
      sources: ["utils.ts"],
      goal: "overview",
      token_budget: 400,
      style: "brief",
    });
    expect(String(brief.packed_context)).toContain("calculateTotal");
    expect(String(brief.packed_context)).not.toContain("return 1");
    expect(String(brief.packed_context)).not.toMatch(/^Snippet /m);

    const deep = buildToolResponse("pack_context", root, {
      sources: ["utils.ts"],
      goal: "ver código",
      token_budget: 4000,
      style: "deep",
    });
    expect(String(deep.packed_context)).toContain("return 1");
    expect(String(deep.packed_context)).toMatch(/Snippet utils\.ts:/);
  });

  it("balanced inclui corpos expression-bodied e inline úteis", async () => {
    const root = setupWorkspace();
    writeFileSync(join(root, "inline.dart"), "int load() => secret();\n", "utf-8");
    writeFileSync(join(root, "inline.py"), "def load(): return secret()\n", "utf-8");
    writeFileSync(
      join(root, "typed.ts"),
      "export function typed(): Promise<string> { return Promise.resolve('secret'); }\n",
      "utf-8",
    );
    expect(await runIndex()).toBe(0);

    const dart = buildToolResponse("pack_context", root, {
      sources: ["inline.dart"], goal: "assinatura", token_budget: 400, style: "balanced",
    });
    const python = buildToolResponse("pack_context", root, {
      sources: ["inline.py"], goal: "assinatura", token_budget: 400, style: "balanced",
    });
    const typed = buildToolResponse("pack_context", root, {
      sources: ["typed.ts"], goal: "assinatura", token_budget: 400, style: "balanced",
    });

    expect(String(dart.packed_context)).toContain("secret()");
    expect(String(python.packed_context)).toContain("return secret()");
    expect(String(typed.packed_context)).toContain("return Promise.resolve");
  });

  it("deep inlina corpo completo (escape hatch)", async () => {
    const root = setupWorkspace();
    expect(await runIndex()).toBe(0);

    const payload = buildToolResponse("pack_context", root, {
      sources: ["utils.ts"],
      goal: "ver código",
      token_budget: 4000,
      style: "deep",
    });
    expect(String(payload.packed_context)).toContain("return 1");
  });

  it("retrieve expande corpos sob demanda com context_lines", async () => {
    const root = setupWorkspace();
    expect(await runIndex()).toBe(0);

    const packed = buildToolResponse("pack_context", root, {
      sources: ["utils.ts"],
      goal: "entender refactor",
      token_budget: 80,
      style: "deep",
    });
    const handle = String(packed.retrieve_handle);

    const expanded = buildToolResponse("retrieve", root, { handle, context_lines: 1 });
    expect(["sucesso", "parcial"]).toContain(expanded.state);
    expect(expanded.context_lines).toBe(1);
    expect(String(expanded.content)).toContain("calculateTotal");
  });

  it("pack-context emite handle quando budget corta material", async () => {
    const root = setupWorkspace();
    expect(await runIndex()).toBe(0);

    const payload = buildToolResponse("pack_context", root, {
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
    expect(readFileSync(join(root, ".argus", "packed-handles", handle, "manifest.json"), "utf-8")).toContain(handle);

    const db = openIndexDb(getIndexDbPath(root), { readonly: true });
    const row = db.prepare("SELECT handle FROM packed_handles WHERE handle = ?").get(handle) as
      | { handle: string }
      | undefined;
    db.close();
    expect(row?.handle).toBe(handle);

    const replay = buildToolResponse("pack_context", root, {
      sources: [handle],
      goal: "reidratar",
      token_budget: 400,
      style: "deep",
    });
    expect(["sucesso", "parcial", "stale"]).toContain(replay.state);
    expect(String(replay.packed_context)).toContain("utils.ts");

    const retrieved = buildToolResponse("retrieve", root, { handle });
    expect(retrieved.state).toBe("sucesso");
    expect(retrieved.reversibility).toBe("full");
    expect(String(retrieved.content)).toContain("utils.ts");
  });

  it("pack-context gera mh_* recuperável para fonte memory: sem depender de corte por budget", () => {
    const root = setupWorkspace();
    const noteDir = join(root, ".argus", "memory", "vault", "inbox");
    mkdirSync(noteDir, { recursive: true });
    writeFileSync(join(noteDir, "nota.md"), "# Nota\n\nconteudo da memoria\n", "utf-8");

    const payload = buildToolResponse("pack_context", root, {
      sources: ["memory:inbox/nota.md"],
      goal: "usar memoria",
      token_budget: 400,
      style: "balanced",
    });
    expect(payload.state).toBe("sucesso");
    expect(String(payload.retrieve_handle)).toMatch(/^mh_[a-f0-9]{16}$/);

    const retrieved = buildToolResponse("retrieve", root, { handle: String(payload.retrieve_handle) });
    expect(retrieved.state).toBe("sucesso");
    expect(String(retrieved.content)).toContain("conteudo da memoria");
  });

  it("pack-context enriquece com notas relacionadas por grafo em fonte symbol", async () => {
    const root = setupWorkspace();
    const noteDir = join(root, ".argus", "memory", "vault", "decision");
    mkdirSync(noteDir, { recursive: true });
    writeFileSync(
      join(noteDir, "graph-pack.md"),
      [
        "---",
        'title: "Pack graph"',
        "type: decision",
        'tags: ["calculateTotal"]',
        "---",
        "",
        "Decisão sobre `calculateTotal` em `utils.ts`.",
      ].join("\n"),
      "utf-8",
    );
    VaultEngine.init(root);
    VaultEngine.sync(root);
    expect(await runIndex()).toBe(0);

    const payload = buildToolResponse("pack_context", root, {
      sources: ["calculateTotal"],
      goal: "entender decisão ligada ao símbolo",
      token_budget: 800,
      style: "balanced",
    });
    expect(["sucesso", "parcial", "stale"]).toContain(payload.state);
    const packed = String(payload.packed_context);
    expect(packed).toContain("Notas relacionadas (grafo)");
    expect(packed).toContain("symbol_mention");
    expect(packed).toContain("Pack graph");
  });

  it("pack-context synthesize retorna payload honesto estruturado", async () => {
    const root = setupWorkspace();
    expect(await runIndex()).toBe(0);

    const payload = await buildToolResponseAsync("pack_context", root, {
      sources: ["utils.ts"],
      goal: "sintetizar contexto",
      token_budget: 400,
      style: "balanced",
      synthesize: true,
      response_format: "detailed",
    });
    expect(["sucesso", "parcial", "stale"]).toContain(payload.state);
    const synthesis = payload.synthesis as {
      goal?: string;
      state?: string;
      known?: unknown[];
      unknown?: unknown[];
      contradictions?: unknown[];
      stale_sources?: unknown[];
      citations?: unknown[];
      handles?: { retrieve_handle?: string };
      dry_run_prompt?: string;
    };
    expect(synthesis.goal).toBe("sintetizar contexto");
    expect(Array.isArray(synthesis.known)).toBe(true);
    expect(Array.isArray(synthesis.unknown)).toBe(true);
    expect(Array.isArray(synthesis.contradictions)).toBe(true);
    expect(Array.isArray(synthesis.stale_sources)).toBe(true);
    expect(Array.isArray(synthesis.citations)).toBe(true);
    expect(synthesis.handles).toBeDefined();
    expect(synthesis.state).toBe("parcial");
    expect(synthesis.unknown?.length).toBeGreaterThan(0);
  });

  it("todo known tem citation_ids resolvíveis em citations", async () => {
    const root = setupWorkspace();
    expect(await runIndex()).toBe(0);
    writeMemoryConfig(
      {
        vault_path: join(root, ".argus", "memory", "vault"),
        db_path: join(root, ".argus", "memory", "memory.db"),
        llm_provider: "openai",
        openai_api_key: "test-key",
      },
      root,
    );
    vi.spyOn(await import("../src/memory/llm-provider.js"), "createLlmProvider").mockReturnValue({
      complete: vi.fn().mockResolvedValue(
        JSON.stringify({
          known: [{ text: "calculateTotal existe em utils.ts", citation_ids: ["cite_origin_0"] }],
          unknown: [],
        }),
      ),
    });

    const payload = await buildToolResponseAsync("pack_context", root, {
      sources: ["utils.ts"],
      goal: "sintetizar contexto",
      token_budget: 400,
      style: "balanced",
      synthesize: true,
      response_format: "detailed",
    });
    const synthesis = payload.synthesis as {
      known?: Array<{ citation_ids?: string[] }>;
      citations?: Array<{ id: string }>;
    };
    const citationIds = new Set((synthesis.citations ?? []).map((item) => item.id));
    for (const item of synthesis.known ?? []) {
      for (const id of item.citation_ids ?? []) {
        expect(citationIds.has(id)).toBe(true);
      }
    }
  });

  it("nota contraditoria entra em contradictions e nao em known", async () => {
    const root = setupWorkspace();
    const noteDir = join(root, ".argus", "memory", "vault", "inbox");
    mkdirSync(noteDir, { recursive: true });
    writeFileSync(
      join(noteDir, "conflict.md"),
      [
        "---",
        'title: "Conflito pack"',
        "type: inbox",
        "scope: project",
        "source: direct_capture",
        "confidence: inferred",
        "observed_at: 2026-01-01T00:00:00.000Z",
        'contradiction_reason: "conflicting_values_same_scope"',
        "---",
        "",
        "token conflict pack unique",
        "",
      ].join("\n"),
      "utf-8",
    );
    VaultEngine.init(root);
    VaultEngine.sync(root);

    const payload = await buildToolResponseAsync("pack_context", root, {
      sources: ["memory:inbox/conflict.md"],
      goal: "token conflict pack",
      token_budget: 400,
      style: "balanced",
      synthesize: true,
      response_format: "detailed",
    });
    const synthesis = payload.synthesis as {
      contradictions?: Array<{ reason?: string }>;
      known?: unknown[];
    };
    expect((synthesis.contradictions ?? []).some((item) => item.reason?.includes("conflicting"))).toBe(true);
    expect(synthesis.known ?? []).toHaveLength(0);
  });

  it("fonte memory explicitamente empacotada expõe contradição mesmo fora do recall por goal", async () => {
    const root = setupWorkspace();
    const noteDir = join(root, ".argus", "memory", "vault", "inbox");
    mkdirSync(noteDir, { recursive: true });
    writeFileSync(
      join(noteDir, "explicit-conflict.md"),
      [
        "---",
        'title: "Conflito explícito"',
        "type: inbox",
        "scope: project",
        "source: direct_capture",
        "confidence: inferred",
        "observed_at: 2026-01-01T00:00:00.000Z",
        'contradiction_reason: "explicit_source_conflict"',
        "---",
        "",
        "alpha beta gamma",
        "",
      ].join("\n"),
      "utf-8",
    );
    VaultEngine.init(root);
    VaultEngine.sync(root);

    const payload = await buildToolResponseAsync("pack_context", root, {
      sources: ["memory:inbox/explicit-conflict.md"],
      goal: "objetivo sem tokens da nota",
      token_budget: 400,
      style: "balanced",
      synthesize: true,
      response_format: "detailed",
    });
    const synthesis = payload.synthesis as {
      contradictions?: Array<{ reason?: string }>;
    };
    expect((synthesis.contradictions ?? []).some((item) => item.reason === "explicit_source_conflict")).toBe(true);
  });

  it("nota stale entra em stale_sources", async () => {
    const root = setupWorkspace();
    const noteDir = join(root, ".argus", "memory", "vault", "inbox");
    mkdirSync(noteDir, { recursive: true });
    writeFileSync(
      join(noteDir, "stale.md"),
      [
        "---",
        'title: "Stale pack"',
        "type: inbox",
        "scope: project",
        "source: direct_capture",
        "confidence: inferred",
        "observed_at: 2026-01-01T00:00:00.000Z",
        'stale_reason: "session_expired"',
        "---",
        "",
        "token stale pack unique",
        "",
      ].join("\n"),
      "utf-8",
    );
    VaultEngine.init(root);
    VaultEngine.sync(root);

    const payload = await buildToolResponseAsync("pack_context", root, {
      sources: ["memory:inbox/stale.md"],
      goal: "token stale pack",
      token_budget: 400,
      style: "balanced",
      synthesize: true,
      response_format: "detailed",
    });
    const synthesis = payload.synthesis as {
      stale_sources?: Array<{ reason?: string }>;
    };
    expect((synthesis.stale_sources ?? []).some((item) => item.reason === "session_expired")).toBe(true);
  });

  it("sem LLM configurado retorna synthesis parcial com gaps", async () => {
    const root = setupWorkspace();
    expect(await runIndex()).toBe(0);

    const payload = await buildToolResponseAsync("pack_context", root, {
      sources: ["utils.ts"],
      goal: "sintetizar sem llm",
      token_budget: 400,
      style: "balanced",
      synthesize: true,
      response_format: "detailed",
    });
    const synthesis = payload.synthesis as { state?: string; unknown?: unknown[] };
    expect(synthesis.state).toBe("parcial");
    expect((synthesis.unknown ?? []).length).toBeGreaterThan(0);
    expect(payload.state).not.toBe("falha");
  });

  it("provider falhando degrada para parcial sem falhar a tool", async () => {
    const root = setupWorkspace();
    expect(await runIndex()).toBe(0);
    writeMemoryConfig(
      {
        vault_path: join(root, ".argus", "memory", "vault"),
        db_path: join(root, ".argus", "memory", "memory.db"),
        llm_provider: "openai",
        openai_api_key: "invalid-key",
      },
      root,
    );
    vi.spyOn(await import("../src/memory/llm-provider.js"), "createLlmProvider").mockReturnValue({
      complete: vi.fn().mockRejectedValue(new LlmProviderError("E_LLM_FAILED", "provider down")),
    });

    const payload = await buildToolResponseAsync("pack_context", root, {
      sources: ["utils.ts"],
      goal: "sintetizar com falha",
      token_budget: 400,
      style: "balanced",
      synthesize: true,
      response_format: "detailed",
    });
    const synthesis = payload.synthesis as { state?: string; unknown?: unknown[] };
    expect(synthesis.state).toBe("parcial");
    expect(payload.state).not.toBe("falha");
    expect((synthesis.unknown ?? []).length).toBeGreaterThan(0);
  });

  it("budget insuficiente declara truncamento em unknown com handle", async () => {
    const root = setupWorkspace();
    expect(await runIndex()).toBe(0);

    const payload = await buildToolResponseAsync("pack_context", root, {
      sources: ["utils.ts"],
      goal: "entender refactor",
      token_budget: 80,
      style: "deep",
      synthesize: true,
      response_format: "detailed",
    });
    const synthesis = payload.synthesis as {
      unknown?: Array<{ reason?: string; handle?: string }>;
      handles?: { retrieve_handle?: string };
    };
    expect(typeof payload.retrieve_handle).toBe("string");
    expect(
      (synthesis.unknown ?? []).some(
        (item) => item.reason === "budget_truncation" && item.handle === payload.retrieve_handle,
      ),
    ).toBe(true);
    expect(synthesis.handles?.retrieve_handle).toBe(payload.retrieve_handle);
  });

  it("budget insuficiente mantém synthesis parcial mesmo com LLM respondendo", async () => {
    const root = setupWorkspace();
    expect(await runIndex()).toBe(0);
    writeMemoryConfig(
      {
        vault_path: join(root, ".argus", "memory", "vault"),
        db_path: join(root, ".argus", "memory", "memory.db"),
        llm_provider: "openai",
        openai_api_key: "test-key",
      },
      root,
    );
    vi.spyOn(await import("../src/memory/llm-provider.js"), "createLlmProvider").mockReturnValue({
      complete: vi.fn().mockResolvedValue(JSON.stringify({ known: [], unknown: [] })),
    });

    const payload = await buildToolResponseAsync("pack_context", root, {
      sources: ["utils.ts"],
      goal: "entender refactor",
      token_budget: 80,
      style: "deep",
      synthesize: true,
      response_format: "detailed",
    });
    const synthesis = payload.synthesis as {
      state?: string;
      unknown?: Array<{ reason?: string }>;
    };
    expect(synthesis.state).toBe("parcial");
    expect((synthesis.unknown ?? []).some((item) => item.reason === "budget_truncation")).toBe(true);
  });

  it("sem synthesize mantem contrato baseline sem synthesis", async () => {
    const root = setupWorkspace();
    expect(await runIndex()).toBe(0);

    const payload = buildToolResponse("pack_context", root, {
      sources: ["utils.ts"],
      goal: "entender refactor",
      token_budget: 400,
      style: "balanced",
    });
    expect(payload.synthesis).toBeUndefined();
    expect(String(payload.packed_context)).toContain("utils.ts");
    expect((payload.origin_refs as unknown[]).length).toBeGreaterThan(0);
    expect(payload.reversibility).toBe("full");
  });

  it("MCP_TOOL_NAMES permanece com 12 tools", () => {
    expect(MCP_TOOL_NAMES).toHaveLength(12);
    expect(MCP_TOOL_NAMES).not.toContain("think");
  });

  it("GC evict handles antigos ao gravar um novo (TTL)", async () => {
    const root = setupWorkspace();
    expect(await runIndex()).toBe(0);

    // Handle "velho" (> 7 dias) registrado no índice + dir em disco.
    const stale = "rh_aaaaaaaaaaaaaaaa";
    const staleDir = join(root, ".argus", "packed-handles", stale);
    mkdirSync(staleDir, { recursive: true });
    writeFileSync(join(staleDir, "manifest.json"), "{}", "utf-8");
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const db = openIndexDb(getIndexDbPath(root));
    db.prepare("INSERT OR REPLACE INTO packed_handles (handle, created_at) VALUES (?, ?)").run(stale, old);
    db.close();

    // Pack com perda de budget → grava novo handle → dispara GC.
    const payload = buildToolResponse("pack_context", root, {
      sources: ["utils.ts"],
      goal: "forcar handle",
      token_budget: 80,
      style: "deep",
    });
    expect(typeof payload.retrieve_handle).toBe("string");

    const db2 = openIndexDb(getIndexDbPath(root), { readonly: true });
    const row = db2.prepare("SELECT handle FROM packed_handles WHERE handle = ?").get(stale);
    db2.close();
    expect(row).toBeUndefined();
    expect(existsSync(staleDir)).toBe(false);
  });

  it("GC preserva o handle recém-criado quando timestamps empatam no cap", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-17T12:00:00.000Z"));
    const root = setupWorkspace();
    expect(await runIndex()).toBe(0);
    const createdAt = new Date().toISOString();
    const db = openIndexDb(getIndexDbPath(root));
    for (let i = 0; i < 50; i += 1) {
      db.prepare("INSERT INTO packed_handles (handle, created_at) VALUES (?, ?)").run(
        `rh_${i.toString(16).padStart(16, "0")}`,
        createdAt,
      );
    }
    db.close();

    const payload = buildToolResponse("pack_context", root, {
      sources: ["utils.ts"], goal: "forcar handle", token_budget: 80, style: "deep",
    });
    const handle = String(payload.retrieve_handle);
    const db2 = openIndexDb(getIndexDbPath(root), { readonly: true });
    const row = db2.prepare("SELECT handle FROM packed_handles WHERE handle = ?").get(handle);
    const count = db2.prepare("SELECT COUNT(*) AS count FROM packed_handles").get() as { count: number };
    db2.close();

    expect(row).toBeDefined();
    expect(count.count).toBe(50);
    expect(existsSync(join(root, ".argus", "packed-handles", handle))).toBe(true);
  });

  it("retrieve rejeita traversal e handles de outro workspace", async () => {
    const root = setupWorkspace();
    expect(await runIndex()).toBe(0);

    const traversal = buildToolResponse("retrieve", root, { handle: "../manifest" });
    expect(traversal.state).toBe("falha");
    expect(String(traversal.message)).toContain("E_RETRIEVE_INVALID");

    const missing = buildToolResponse("retrieve", root, { handle: "rh_0123456789abcdef" });
    expect(missing.state).toBe("falha");
    expect(String(missing.message)).toContain("E_RETRIEVE_NOT_FOUND");
  });

  it("retrieve rejeita body_file adulterado fora do workspace", async () => {
    const root = setupWorkspace();
    expect(await runIndex()).toBe(0);
    const external = join(tmpdir(), `argus-secret-${Date.now()}.txt`);
    const handle = "rh_0123456789abcdef";
    const handleDir = join(root, ".argus", "packed-handles", handle);
    mkdirSync(handleDir, { recursive: true });
    writeFileSync(external, "segredo externo\n", "utf-8");
    writeFileSync(
      join(handleDir, "manifest.json"),
      JSON.stringify({
        segments: [{ ref: "externo", originRefs: [], body_file: relative(handleDir, external) }],
      }),
      "utf-8",
    );

    try {
      const payload = buildToolResponse("retrieve", root, { handle, response_format: "detailed" });
      expect(payload.state).toBe("falha");
      expect(String(payload.content)).not.toContain("segredo externo");
      expect((payload.limitations as string[]).some((item) => item.includes("fora do workspace"))).toBe(true);
    } finally {
      rmSync(external, { force: true });
    }
  });

  it("retrieve degrada manifesto estruturalmente inválido sem lançar exceção", async () => {
    const root = setupWorkspace();
    expect(await runIndex()).toBe(0);
    const handle = "rh_0123456789abcdef";
    const handleDir = join(root, ".argus", "packed-handles", handle);
    mkdirSync(handleDir, { recursive: true });
    writeFileSync(join(handleDir, "manifest.json"), "{}", "utf-8");

    const payload = buildToolResponse("retrieve", root, { handle });
    expect(payload.state).toBe("falha");
    expect(String(payload.message)).toContain("E_RETRIEVE_UNAVAILABLE");
  });

  it("pack-context degrada para partial quando handle perde segmento persistido", async () => {
    const root = setupWorkspace();
    expect(await runIndex()).toBe(0);

    const payload = buildToolResponse("pack_context", root, {
      sources: ["utils.ts", "dep.ts"],
      goal: "entender refactor",
      token_budget: 110,
      style: "deep",
    });
    const handle = String(payload.retrieve_handle);
    rmSync(join(root, ".argus", "packed-handles", handle, "segment-001.txt"));

    const replay = buildToolResponse("pack_context", root, {
      sources: [handle],
      goal: "reidratar parcial",
      token_budget: 400,
      style: "deep",
      response_format: "detailed",
    });
    expect(replay.state).toBe("parcial");
    expect(replay.reversibility).toBe("partial");
    expect((replay.limitations as string[]).some((item) => item.includes("Segmento ausente"))).toBe(true);
  });

  it("pack-context falha sem fontes úteis", async () => {
    const root = setupWorkspace();
    expect(await runIndex()).toBe(0);

    const payload = buildToolResponse("pack_context", root, {
      sources: [],
      goal: "entender",
      token_budget: 120,
    });
    expect(payload.state).toBe("falha");
  });
});
