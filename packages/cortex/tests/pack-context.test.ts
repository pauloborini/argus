import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runIndex } from "../src/commands/index-cmd.js";
import { openIndexDb } from "../src/storage/sqlite-index-store.js";
import { buildToolStub } from "../src/mcp/tools/stubs.js";
import { getIndexDbPath, initWorkspace } from "../src/workspace/workspace.js";

describe("pack context tool", () => {
  let tempDir: string | undefined;
  let originalCwd: string | undefined;

  afterEach(() => {
    vi.useRealTimers();
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

  it("overview-first: balanced empacota assinatura sem inlinar o corpo", async () => {
    const root = setupWorkspace();
    expect(await runIndex()).toBe(0);

    const payload = buildToolStub("pack_context", root, {
      sources: ["utils.ts"],
      goal: "entender refactor",
      token_budget: 400,
      style: "balanced",
    });
    const packed = String(payload.packed_context);
    expect(packed).toContain("calculateTotal");
    // Assinatura presente, corpo (`helper(); return 1`) ausente.
    expect(packed).not.toContain("return 1");
  });

  it("overview-first: balanced corta corpos expression-bodied e inline", async () => {
    const root = setupWorkspace();
    writeFileSync(join(root, "inline.dart"), "int load() => secret();\n", "utf-8");
    writeFileSync(join(root, "inline.py"), "def load(): return secret()\n", "utf-8");
    writeFileSync(
      join(root, "typed.ts"),
      "export function typed(): Promise<string> { return Promise.resolve('secret'); }\n",
      "utf-8",
    );
    expect(await runIndex()).toBe(0);

    const dart = buildToolStub("pack_context", root, {
      sources: ["inline.dart"], goal: "assinatura", token_budget: 400, style: "balanced",
    });
    const python = buildToolStub("pack_context", root, {
      sources: ["inline.py"], goal: "assinatura", token_budget: 400, style: "balanced",
    });
    const typed = buildToolStub("pack_context", root, {
      sources: ["typed.ts"], goal: "assinatura", token_budget: 400, style: "balanced",
    });

    expect(String(dart.packed_context)).toContain("int load()");
    expect(String(dart.packed_context)).not.toContain("secret()");
    expect(String(python.packed_context)).toContain("def load():");
    expect(String(python.packed_context)).not.toContain("return secret()");
    expect(String(typed.packed_context)).toContain("typed(): Promise<string>");
    expect(String(typed.packed_context)).not.toContain("return Promise.resolve");
  });

  it("deep inlina corpo completo (escape hatch)", async () => {
    const root = setupWorkspace();
    expect(await runIndex()).toBe(0);

    const payload = buildToolStub("pack_context", root, {
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

    const packed = buildToolStub("pack_context", root, {
      sources: ["utils.ts"],
      goal: "entender refactor",
      token_budget: 80,
      style: "deep",
    });
    const handle = String(packed.retrieve_handle);

    const expanded = buildToolStub("retrieve", root, { handle, context_lines: 1 });
    expect(["sucesso", "parcial"]).toContain(expanded.state);
    expect(expanded.context_lines).toBe(1);
    expect(String(expanded.content)).toContain("calculateTotal");
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

    const retrieved = buildToolStub("retrieve", root, { handle });
    expect(retrieved.state).toBe("sucesso");
    expect(retrieved.reversibility).toBe("full");
    expect(String(retrieved.content)).toContain("utils.ts");
  });

  it("GC evict handles antigos ao gravar um novo (TTL)", async () => {
    const root = setupWorkspace();
    expect(await runIndex()).toBe(0);

    // Handle "velho" (> 7 dias) registrado no índice + dir em disco.
    const stale = "rh_aaaaaaaaaaaaaaaa";
    const staleDir = join(root, ".cortex", "packed-handles", stale);
    mkdirSync(staleDir, { recursive: true });
    writeFileSync(join(staleDir, "manifest.json"), "{}", "utf-8");
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const db = openIndexDb(getIndexDbPath(root));
    db.prepare("INSERT OR REPLACE INTO packed_handles (handle, created_at) VALUES (?, ?)").run(stale, old);
    db.close();

    // Pack com perda de budget → grava novo handle → dispara GC.
    const payload = buildToolStub("pack_context", root, {
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

    const payload = buildToolStub("pack_context", root, {
      sources: ["utils.ts"], goal: "forcar handle", token_budget: 80, style: "deep",
    });
    const handle = String(payload.retrieve_handle);
    const db2 = openIndexDb(getIndexDbPath(root), { readonly: true });
    const row = db2.prepare("SELECT handle FROM packed_handles WHERE handle = ?").get(handle);
    const count = db2.prepare("SELECT COUNT(*) AS count FROM packed_handles").get() as { count: number };
    db2.close();

    expect(row).toBeDefined();
    expect(count.count).toBe(50);
    expect(existsSync(join(root, ".cortex", "packed-handles", handle))).toBe(true);
  });

  it("retrieve rejeita traversal e handles de outro workspace", async () => {
    const root = setupWorkspace();
    expect(await runIndex()).toBe(0);

    const traversal = buildToolStub("retrieve", root, { handle: "../manifest" });
    expect(traversal.state).toBe("falha");
    expect(String(traversal.message)).toContain("E_RETRIEVE_INVALID");

    const missing = buildToolStub("retrieve", root, { handle: "rh_0123456789abcdef" });
    expect(missing.state).toBe("falha");
    expect(String(missing.message)).toContain("E_RETRIEVE_NOT_FOUND");
  });

  it("retrieve rejeita body_file adulterado fora do workspace", async () => {
    const root = setupWorkspace();
    expect(await runIndex()).toBe(0);
    const external = join(tmpdir(), `cortex-secret-${Date.now()}.txt`);
    const handle = "rh_0123456789abcdef";
    const handleDir = join(root, ".cortex", "packed-handles", handle);
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
      const payload = buildToolStub("retrieve", root, { handle, response_format: "detailed" });
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
    const handleDir = join(root, ".cortex", "packed-handles", handle);
    mkdirSync(handleDir, { recursive: true });
    writeFileSync(join(handleDir, "manifest.json"), "{}", "utf-8");

    const payload = buildToolStub("retrieve", root, { handle });
    expect(payload.state).toBe("falha");
    expect(String(payload.message)).toContain("E_RETRIEVE_UNAVAILABLE");
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
      response_format: "detailed",
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
