import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeEmbedder } from "../../src/embeddings/embedder.js";
import { buildToolResponseAsync } from "../../src/mcp/tools/response.js";
import { DreamEngine } from "../../src/memory/dream-engine.js";
import { migrateLegacyAthena } from "../../src/memory/migrate-legacy-athena.js";
import { ThinkEngine } from "../../src/memory/think-engine.js";
import { VaultEngine } from "../../src/memory/vault-engine.js";
import { initWorkspace } from "../../src/workspace/workspace.js";

describe("memory vault", () => {
  let tempDir: string | undefined;

  afterEach(() => {
    vi.restoreAllMocks();
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  function root(): string {
    tempDir = mkdtempSync(join(tmpdir(), "argus-memory-"));
    initWorkspace(tempDir);
    return tempDir;
  }

  it("recall usa hybrid-rrf somente após embeddings reais no cofre", async () => {
    const cwd = root();
    const remembered = VaultEngine.remember("# Billing\n\ninvoice payment flow", { type: "decision" }, cwd);
    expect(remembered.state).toBe("sucesso");
    expect(VaultEngine.sync(cwd).state).toBe("sucesso");

    const fts = VaultEngine.search("Billing", { limit: 5 }, cwd);
    expect(fts.mechanism).toBe("fts-only");

    expect((await VaultEngine.embed(cwd, new FakeEmbedder())).state).toBe("sucesso");
    const recalled = await VaultEngine.recall("Billing", { limit: 5 }, cwd, new FakeEmbedder());
    expect(recalled.state).toBe("sucesso");
    expect(recalled.mechanism).toBe("hybrid-rrf");
    expect(recalled.chunks.some((chunk) => chunk.path.includes("decision"))).toBe(true);
  });

  it("status.memory fica stale quando nota muda depois do sync", () => {
    const cwd = root();
    VaultEngine.init(cwd);
    const note = join(cwd, ".argus", "memory", "vault", "inbox", "manual.md");
    writeFileSync(note, "# Nota\n\nantes\n", "utf-8");
    expect(VaultEngine.sync(cwd).state).toBe("sucesso");
    expect(VaultEngine.status(cwd).staleness).toBe("fresh");

    writeFileSync(note, "# Nota\n\ndepois\n", "utf-8");
    expect(VaultEngine.status(cwd).staleness).toBe("stale");
  });

  it("semantic_search domain=memory funciona sem index.db de código", async () => {
    const cwd = root();
    VaultEngine.remember("# Nota\n\nmemoria isolada", {}, cwd);
    VaultEngine.sync(cwd);

    const payload = await buildToolResponseAsync("semantic_search", cwd, {
      query: "memoria",
      domain: "memory",
      response_format: "detailed",
    }, { embedder: new FakeEmbedder() });
    expect(payload.state).toBe("parcial");
    expect(payload.mechanism).toBe("fts-only");
    expect((payload.candidates as unknown[]).length).toBeGreaterThan(0);
  });

  it("migração preserva config legado e força paths Argus", () => {
    const cwd = root();
    rmSync(join(cwd, ".argus", "memory"), { recursive: true, force: true });
    const athenaDir = join(cwd, ".athena");
    const vaultDir = join(athenaDir, "vault", "inbox");
    mkdirSync(vaultDir, { recursive: true });
    writeFileSync(join(vaultDir, "legacy.md"), "# Legacy\n", "utf-8");
    writeFileSync(join(athenaDir, "athena-vault.db"), "legacy-db", "utf-8");
    writeFileSync(
      join(athenaDir, "config.json"),
      JSON.stringify({ llm_provider: "openai", argus_db_path: "/old/index.db", custom: "kept" }),
      "utf-8",
    );

    const result = migrateLegacyAthena(cwd);
    expect(result.status).toBe("migrated");
    const config = JSON.parse(readFileSync(join(cwd, ".argus", "memory", "config.json"), "utf-8")) as {
      llm_provider: string;
      vault_path: string;
      db_path: string;
      code_index_path: string;
      argus_db_path?: string;
      custom?: string;
    };
    expect(config.llm_provider).toBe("openai");
    expect(config.custom).toBe("kept");
    expect(config.argus_db_path).toBeUndefined();
    expect(config.vault_path).toBe(join(cwd, ".argus", "memory", "vault"));
    expect(config.db_path).toBe(join(cwd, ".argus", "memory", "memory.db"));
    expect(config.code_index_path).toBe(join(cwd, ".argus", "index.db"));
  });

  it("migração falha preservando origem .athena", () => {
    const cwd = root();
    rmSync(join(cwd, ".argus", "memory"), { recursive: true, force: true });
    const athenaDir = join(cwd, ".athena");
    const vaultDir = join(athenaDir, "vault", "inbox");
    mkdirSync(vaultDir, { recursive: true });
    writeFileSync(join(vaultDir, "legacy.md"), "# Legacy\n", "utf-8");
    vi.spyOn(Date, "now").mockReturnValue(123);
    writeFileSync(join(cwd, ".argus", `memory.migrating-${process.pid}-123`), "blocks tmp dir", "utf-8");

    const result = migrateLegacyAthena(cwd);

    expect(result.status).toBe("failed");
    expect(existsSync(join(athenaDir, "vault", "inbox", "legacy.md"))).toBe(true);
    expect(existsSync(join(cwd, ".argus", "memory"))).toBe(false);
  });

  it("think dry-run monta prompt com citações e gaps", async () => {
    const cwd = root();
    VaultEngine.remember("# Arquitetura\n\ndecisão de memória local", { type: "decision" }, cwd);
    VaultEngine.sync(cwd);

    const result = await ThinkEngine.think("memória local", { cwd, dryRun: true });
    expect(result.state).toBe("sucesso");
    expect(String(result.dry_run_prompt)).toContain("memória local");
    expect(Array.isArray(result.citations)).toBe(true);
    expect(Array.isArray(result.gaps)).toBe(true);
  });

  it("dream tria inbox local e gera relatório sem sqlite-vec", async () => {
    const cwd = root();
    VaultEngine.init(cwd);
    const note = join(cwd, ".argus", "memory", "vault", "inbox", "decisao.md");
    writeFileSync(note, "# Decisão\n\nDecisão: usar Argus memory.\n", "utf-8");
    VaultEngine.sync(cwd);

    const result = await DreamEngine.run(cwd);
    expect(result.state).toBe("sucesso");
    expect(result.triaged_count).toBe(1);
    expect(existsSync(join(cwd, ".argus", "memory", "vault", "decisions", "decisao.md"))).toBe(true);
    expect(existsSync(join(cwd, ".argus", "memory", "vault", "reports", `dream-report-${new Date().toISOString().slice(0, 10)}.md`))).toBe(true);
  });
});
