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
import { initWorkspace } from "../src/workspace/workspace.js";

interface Candidate {
  name: string;
  path: string;
  match_reason: string;
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
});
