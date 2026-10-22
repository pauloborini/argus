import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runIndex } from "../src/commands/index-cmd.js";
import { runEmbed } from "../src/commands/embed-cmd.js";
import { buildIndexEnvelope } from "../src/mcp/tools/common.js";
import { buildSemanticSearchResponse } from "../src/mcp/tools/semantic-search.js";
import { FakeEmbedder, type Embedder } from "../src/embeddings/embedder.js";
import { VaultEngine } from "../src/memory/vault-engine.js";
import { initWorkspace } from "../src/workspace/workspace.js";

class DivergentEmbedder implements Embedder {
  readonly model: string;
  readonly dim: number;
  constructor(model = "divergent-model", dim = 64) {
    this.model = model;
    this.dim = dim;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map(() => new Float32Array(this.dim).fill(0.1));
  }
}

describe("Embedding Identity Guards (GN-04 / §7.1, §7.2, §7.4)", () => {
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

  function write(root: string, rel: string, content: string): void {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf-8");
  }

  async function setupWorkspace(): Promise<string> {
    originalCwd = process.cwd();
    tempDir = mkdtempSync(join(tmpdir(), "argus-embed-id-"));
    write(tempDir, "src/billing.ts", "export function calculateTotal() { return 42; }\n");
    write(tempDir, "src/auth.ts", "export function validateSession() { return true; }\n");
    initWorkspace(tempDir);
    process.chdir(tempDir);
    expect(await runIndex()).toBe(0);
    return tempDir;
  }

  describe("§7.1 — semantic_search no query path de código", () => {
    it("degrada para fts-only com state parcial e limitation W_EMBEDDING_IDENTITY_MISMATCH quando modelo diverge", async () => {
      const root = await setupWorkspace();
      const baseEmbedder = new FakeEmbedder(64);
      expect(await runEmbed({ embedder: baseEmbedder })).toBe(0);

      const envelope = buildIndexEnvelope(root, "lite");
      const divergentEmbedder = new DivergentEmbedder("different-model", 64);

      const payload = await buildSemanticSearchResponse(
        root,
        envelope,
        { query: "calculateTotal", mode: "hybrid" },
        { embedder: divergentEmbedder },
      );

      expect(payload.state).toBe("parcial");
      expect(payload.mechanism).toBe("fts-only");
      expect(payload.limitations).toBeDefined();
      expect(payload.limitations?.some((l: string) => l.includes("W_EMBEDDING_IDENTITY_MISMATCH"))).toBe(true);

      const candidates = payload.candidates as Array<{ name: string; match_reason: string }>;
      expect(candidates.length).toBeGreaterThan(0);
      expect(candidates.every((c) => c.match_reason === "lexical")).toBe(true);
    });

    it("degrada para fts-only quando dimensão diverge mesmo com mesmo model name", async () => {
      const root = await setupWorkspace();
      const baseEmbedder = new FakeEmbedder(64);
      expect(await runEmbed({ embedder: baseEmbedder })).toBe(0);

      const envelope = buildIndexEnvelope(root, "lite");
      const divergentDimEmbedder = new FakeEmbedder(128);

      const payload = await buildSemanticSearchResponse(
        root,
        envelope,
        { query: "validateSession", mode: "hybrid" },
        { embedder: divergentDimEmbedder },
      );

      expect(payload.state).toBe("parcial");
      expect(payload.mechanism).toBe("fts-only");
      expect(payload.limitations?.some((l: string) => l.includes("W_EMBEDDING_IDENTITY_MISMATCH"))).toBe(true);
    });

    it("executa busca densa normal quando modelo e dimensão convergem", async () => {
      const root = await setupWorkspace();
      const baseEmbedder = new FakeEmbedder(64);
      expect(await runEmbed({ embedder: baseEmbedder })).toBe(0);

      const envelope = buildIndexEnvelope(root, "lite");
      const payload = await buildSemanticSearchResponse(
        root,
        envelope,
        { query: "calculateTotal", mode: "hybrid" },
        { embedder: baseEmbedder },
      );

      expect(payload.state).toBe("sucesso");
      expect(payload.limitations?.some((l: string) => l.includes("W_EMBEDDING_IDENTITY_MISMATCH"))).toBeFalsy();
      const candidates = payload.candidates as Array<{ name: string; match_reason: string }>;
      expect(candidates.some((c) => c.match_reason === "semantic" || c.match_reason === "hybrid")).toBe(true);
    });
  });

  describe("§7.2 — memória (VaultEngine.recall e semanticSearch)", () => {
    it("recall degrada para fts-only com state parcial e limitation W_EMBEDDING_IDENTITY_MISMATCH quando meta diverge", async () => {
      const root = await setupWorkspace();
      const baseEmbedder = new FakeEmbedder(64);

      // Adiciona nota e gera embeddings no cofre
      await VaultEngine.remember("Nota importante sobre cálculo e faturamento de clientes", { type: "reference" }, root);
      const embedRes = await VaultEngine.embed(root, baseEmbedder);
      expect(embedRes.state).toBe("sucesso");

      const divergentEmbedder = new DivergentEmbedder("other-vault-model", 64);
      const recallRes = await VaultEngine.recall("faturamento", {}, root, divergentEmbedder);

      expect(recallRes.state).toBe("parcial");
      expect(recallRes.mechanism).toBe("fts-only");
      expect(recallRes.limitations?.some((l: string) => l.includes("W_EMBEDDING_IDENTITY_MISMATCH"))).toBe(true);
    });

    it("semanticSearch na memória retorna fallback lexical quando meta diverge", async () => {
      const root = await setupWorkspace();
      const baseEmbedder = new FakeEmbedder(64);

      await VaultEngine.remember("Nota sobre autenticação e sessão de usuário", { type: "reference" }, root);
      await VaultEngine.embed(root, baseEmbedder);

      const divergentEmbedder = new DivergentEmbedder("other-vault-model", 64);
      const results = await VaultEngine.semanticSearch("sessão", {}, root, divergentEmbedder);

      expect(results.length).toBeGreaterThan(0);
    });

    it("recall executa hybrid-rrf quando identidade converge", async () => {
      const root = await setupWorkspace();
      const baseEmbedder = new FakeEmbedder(64);

      await VaultEngine.remember("Nota sobre infraestrutura e deploy contínuo", { type: "reference" }, root);
      await VaultEngine.embed(root, baseEmbedder);

      const recallRes = await VaultEngine.recall("deploy", {}, root, baseEmbedder);
      expect(recallRes.mechanism).toBe("hybrid-rrf");
      expect(recallRes.limitations?.some((l: string) => l.includes("W_EMBEDDING_IDENTITY_MISMATCH"))).toBeFalsy();
    });
  });

  describe("§7.4 — índice sem embeddings_meta", () => {
    it("índice sem embeddings degrada honestamente com W_EMBEDDINGS_UNAVAILABLE sem falhar", async () => {
      const root = await setupWorkspace();
      const envelope = buildIndexEnvelope(root, "lite");

      const payload = await buildSemanticSearchResponse(
        root,
        envelope,
        { query: "calculateTotal" },
      );

      expect(payload.state).toBe("parcial");
      expect(payload.message).toContain("W_EMBEDDINGS_UNAVAILABLE");
      expect(payload.limitations?.some((l: string) => l.includes("W_EMBEDDINGS_UNAVAILABLE") || l.includes("fallback lexical"))).toBe(true);
    });
  });
});
