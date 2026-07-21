/**
 * H5 — Concise honesty acionável (Plano 4 / INV-H4 / D6).
 * Seam: stubResponse → applyResponseFormat (impl real dos dois lados).
 */
import { describe, expect, it } from "vitest";
import { stubResponse } from "../src/contracts/response-state.js";
import { applyResponseFormat } from "../src/mcp/tools/response.js";
import type { ToolResponsePayload } from "../src/mcp/tools/common.js";

describe("concise honesty acionável (H5 / Plano 4)", () => {
  it("AC-4.1.1: concise preserva embedding_status e dropa limitations cosméticas", () => {
    const payload: ToolResponsePayload = {
      ...stubResponse("sucesso", "Nota capturada no cofre."),
      embedding_status: "pending",
      fts_indexed: true,
      limitations: ["Embedding pendente; FTS disponível. Opcional: argus memory embed."],
    };

    const concise = applyResponseFormat(payload, "concise", "remember");
    expect(concise.embedding_status).toBe("pending");
    expect(concise.fts_indexed).toBe(true);
    expect(concise.confidence).toBeUndefined();
    expect(concise.limitations).toBeUndefined();
    expect(concise.message).toBeUndefined();
    expect(concise.staleness_hint).toBeUndefined();
  });

  it("AC-4.1.2: concise preserva retrieve_handle e origin_refs", () => {
    const payload: ToolResponsePayload = {
      ...stubResponse("parcial", "Contexto explorado com truncamento."),
      retrieve_handle: "rh_0123456789abcdef",
      origin_refs: [{ path: "large-symbol.ts", start_line: 1, end_line: 40 }],
      limitations: [
        "Snippet(s) truncados pelos caps balanced; use retrieve com o retrieve_handle para o corpo completo.",
      ],
    };

    const concise = applyResponseFormat(payload, "concise", "explore");
    expect(concise.retrieve_handle).toBe("rh_0123456789abcdef");
    expect(concise.origin_refs).toEqual([{ path: "large-symbol.ts", start_line: 1, end_line: 40 }]);
    expect(concise.limitations).toBeUndefined();
    expect(concise.confidence).toBeUndefined();
  });

  it("AC-4.1.3: códigos E_*/W_* em message/limitations sobrevivem; prosa cosmética some", () => {
    const payload: ToolResponsePayload = {
      ...stubResponse("parcial", "E_MEMORY_HOT_INDEX_FAILED: indexação quente falhou.", {
        limitations: [
          "E_MEMORY_HOT_INDEX_FAILED: detalhe interno.",
          "W_EMBEDDINGS_UNAVAILABLE: modelo ausente.",
          "Retry idempotente: repita remember ou argus memory embed.",
          "E_MEMORY_HOT_INDEX_FAILED: duplicata deve colapsar.",
        ],
        staleness_hint: "STALE_RUN_SYNC: Execute argus sync (prosa cosmética no concise).",
      }),
    };

    const concise = applyResponseFormat(payload, "concise", "remember");
    expect(concise.message).toBe("E_MEMORY_HOT_INDEX_FAILED");
    expect(concise.limitations).toEqual([
      "E_MEMORY_HOT_INDEX_FAILED",
      "W_EMBEDDINGS_UNAVAILABLE",
    ]);
    expect(concise.staleness_hint).toBeUndefined();
    expect(concise.confidence).toBeUndefined();

    const detailed = applyResponseFormat(payload, "detailed", "remember");
    expect(detailed.limitations).toHaveLength(4);
    expect(detailed.staleness_hint).toContain("STALE_RUN_SYNC");
  });
});
