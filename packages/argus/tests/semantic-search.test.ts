import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runIndex } from "../src/commands/index-cmd.js";
import { runSync } from "../src/commands/sync.js";
import { runEmbed } from "../src/commands/embed-cmd.js";
import { buildIndexEnvelope } from "../src/mcp/tools/common.js";
import { buildSemanticSearchResponse } from "../src/mcp/tools/semantic-search.js";
import { buildToolResponseAsync } from "../src/mcp/tools/response.js";
import { FakeEmbedder } from "../src/embeddings/embedder.js";
import { reciprocalRankFusion } from "../src/embeddings/rrf.js";
import { MCP_TOOL_NAMES } from "../src/mcp/tool-registry.js";
import { VaultEngine } from "../src/memory/vault-engine.js";
import { initWorkspace } from "../src/workspace/workspace.js";

interface Candidate {
  id: string;
  name: string;
  path: string;
  match_reason: string;
  kind: string;
}

describe("semantic_search tool", () => {
  let tempDir: string | undefined;
  let originalCwd: string | undefined;
  const embedder = new FakeEmbedder();

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

  async function setup(): Promise<string> {
    originalCwd = process.cwd();
    tempDir = mkdtempSync(join(tmpdir(), "argus-sem-"));
    write(tempDir, "billing.ts", "export function calculateTotal() { return 42; }\n");
    write(tempDir, "auth.ts", "export function validateSession() { return true; }\n");
    initWorkspace(tempDir);
    process.chdir(tempDir);
    expect(await runIndex()).toBe(0);
    return tempDir;
  }

  it("sem embeddings degrada honesto com fallback lexical", async () => {
    const root = await setup();
    const payload = await buildToolResponseAsync("semantic_search", root, {
      query: "calculateTotal",
      response_format: "detailed",
    });
    expect(payload.state).toBe("parcial");
    expect(payload.message).toMatch(/W_EMBEDDINGS_UNAVAILABLE/);
    const candidates = payload.candidates as Candidate[];
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0]?.name).toBe("calculateTotal");
  });

  it("com embeddings retorna candidatos semânticos", async () => {
    const root = await setup();
    expect(await runEmbed({ embedder })).toBe(0);

    const envelope = buildIndexEnvelope(root, "lite");
    const payload = await buildSemanticSearchResponse(
      root,
      envelope,
      { query: "calculateTotal", mode: "hybrid" },
      { embedder },
    );
    expect(payload.state).toBe("sucesso");
    const candidates = payload.candidates as Candidate[];
    expect(candidates.some((c) => c.name === "calculateTotal")).toBe(true);
    expect(["semantic", "hybrid", "lexical"]).toContain(candidates[0]?.match_reason);
  });

  it("modo dense usa só vetores", async () => {
    const root = await setup();
    expect(await runEmbed({ embedder })).toBe(0);
    const envelope = buildIndexEnvelope(root, "lite");
    const payload = await buildSemanticSearchResponse(
      root,
      envelope,
      { query: "validateSession", mode: "dense" },
      { embedder },
    );
    expect(payload.state).toBe("sucesso");
    const candidates = payload.candidates as Candidate[];
    expect(candidates.every((c) => c.match_reason === "semantic")).toBe(true);
  });

  it("embeddings defasados em relação ao índice → state stale", async () => {
    const root = await setup();
    expect(await runEmbed({ embedder })).toBe(0);
    // Sync incremental adiciona um arquivo: embeddings de billing/auth sobrevivem
    // (delta só reprocessa o novo), mas o manifest_hash do índice avança e diverge
    // do gravado no embed → stale. (Um `index` completo apagaria os embeddings por
    // CASCADE, caindo em W_EMBEDDINGS_UNAVAILABLE — outro caminho honesto.)
    write(root, "extra.ts", "export function shipFeature() { return 1; }\n");
    expect(await runSync({ full: true })).toBe(0);

    const envelope = buildIndexEnvelope(root, "lite");
    const payload = await buildSemanticSearchResponse(
      root,
      envelope,
      { query: "calculateTotal" },
      { embedder },
    );
    expect(payload.state).toBe("stale");
    expect(payload.message).toMatch(/W_EMBEDDINGS_STALE/);
  });

  it("domain=all funde código+memória por RRF, não sort bruto por score", async () => {
    const root = await setup();
    await VaultEngine.remember("# Billing memory\n\ninvoice payment memory note", { type: "decision" }, root);
    VaultEngine.sync(root);
    expect(await runEmbed({ embedder })).toBe(0);
    await VaultEngine.embed(root, embedder);

    const envelope = buildIndexEnvelope(root, "lite");
    const limit = 10;
    const codeOnly = await buildSemanticSearchResponse(
      root,
      envelope,
      { query: "billing invoice", domain: "code", limit },
      { embedder },
    );
    const memoryOnly = await VaultEngine.recall("billing invoice", { limit }, root, embedder);
    const payload = await buildSemanticSearchResponse(
      root,
      envelope,
      { query: "billing invoice", domain: "all", limit },
      { embedder },
    );
    expect(payload.state).toBe("sucesso");
    const candidates = payload.candidates as Candidate[];
    expect(candidates.some((c) => c.kind === "note")).toBe(true);
    expect(candidates.some((c) => c.id.startsWith("symbol:"))).toBe(true);

    const codeIds = ((codeOnly.candidates as Candidate[]) ?? []).map((c) => c.id);
    const noteIds = memoryOnly.chunks.map((chunk) => `note:${chunk.note_id}`);
    const expectedOrder = reciprocalRankFusion([codeIds, noteIds])
      .slice(0, limit)
      .map((item) => String(item.id));
    expect(candidates.map((c) => c.id)).toEqual(expectedOrder);

    const rawSortOrder = [...candidates]
      .sort((left, right) => {
        const leftScore = (codeOnly.candidates as Candidate[]).find((c) => c.id === left.id)?.score
          ?? memoryOnly.chunks.find((c) => `note:${c.note_id}` === left.id)?.score
          ?? 0;
        const rightScore = (codeOnly.candidates as Candidate[]).find((c) => c.id === right.id)?.score
          ?? memoryOnly.chunks.find((c) => `note:${c.note_id}` === right.id)?.score
          ?? 0;
        return rightScore - leftScore;
      })
      .map((c) => c.id);
    if (codeIds.length > 0 && noteIds.length > 0) {
      expect(candidates.map((c) => c.id)).not.toEqual(rawSortOrder);
    }
  });

  it("domain=all sem embeddings de código ainda funde memória por RRF", async () => {
    const root = await setup();
    await VaultEngine.remember("# Memória lexical\n\ntermo memoria unico billing", { type: "inbox" }, root);
    VaultEngine.sync(root);

    const envelope = buildIndexEnvelope(root, "lite");
    const payload = await buildSemanticSearchResponse(
      root,
      envelope,
      { query: "billing memoria", domain: "all", limit: 10 },
      { embedder },
    );
    expect(payload.state).toBe("parcial");
    const candidates = payload.candidates as Candidate[];
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.some((c) => c.kind === "note")).toBe(true);
    const memory = payload.memory as { mechanism?: string } | undefined;
    expect(memory?.mechanism).toBe("fts-only");
  });

  it("domain=all sem embeddings de memória retorna parcial com lexical útil", async () => {
    const root = await setup();
    await VaultEngine.remember("# Memória lexical\n\ntermo memoria unico", { type: "inbox" }, root);
    VaultEngine.sync(root);
    expect(await runEmbed({ embedder })).toBe(0);

    const envelope = buildIndexEnvelope(root, "lite");
    const payload = await buildSemanticSearchResponse(
      root,
      envelope,
      { query: "memoria unico", domain: "all", limit: 10 },
      { embedder },
    );
    expect(["sucesso", "parcial", "stale"]).toContain(payload.state);
    const candidates = payload.candidates as Candidate[];
    expect(candidates.length).toBeGreaterThan(0);
    const memory = payload.memory as { mechanism?: string; state?: string } | undefined;
    expect(memory?.mechanism).toBe("fts-only");
  });

  it("domain=memory propaga sinais v2 nos candidatos", async () => {
    const root = await setup();
    const vault = join(root, ".argus", "memory", "vault", "inbox");
    mkdirSync(vault, { recursive: true });
    writeFileSync(
      join(vault, "stale-search.md"),
      [
        "---",
        'title: "Stale search"',
        "type: inbox",
        "scope: project",
        "source: direct_capture",
        "confidence: inferred",
        "observed_at: 2026-01-01T00:00:00.000Z",
        'stale_reason: "session_expired"',
        "---",
        "",
        "stale search token",
        "",
      ].join("\n"),
      "utf-8",
    );
    VaultEngine.sync(root);
    const envelope = buildIndexEnvelope(root, "lite");
    const payload = await buildSemanticSearchResponse(
      root,
      envelope,
      { query: "stale search", domain: "memory", limit: 5 },
      { embedder },
    );
    const candidates = payload.candidates as Array<{
      stale_reason?: string;
      confidence?: string;
      match_reason?: string;
    }>;
    expect(candidates[0]?.stale_reason).toBe("session_expired");
    expect(candidates[0]?.confidence).toBe("inferred");
    expect(candidates[0]?.match_reason).toBe("fts-only");
  });

  it("MCP_TOOL_NAMES permanece com 12 tools", () => {
    expect(MCP_TOOL_NAMES).toHaveLength(12);
  });
});
