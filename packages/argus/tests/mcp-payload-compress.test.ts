import { describe, it, expect } from "vitest";
import { compressPayload, MIN_TOKENS_TO_COMPRESS } from "../src/mcp/tools/payload-compress.js";
import { countTokens } from "../src/packing/tokenizer.js";
import type { ToolResponsePayload } from "../src/mcp/tools/common.js";

describe("compressPayload — token-aware gate (COMPRESS-GATE-001)", () => {
  it("§7.1: payload pequeno (< 250 tokens) sai idêntico ao original sem transformação", () => {
    // Envelope pequeno com paths repetidos que normalmente acionariam applyPathDictionary
    const smallPayload: ToolResponsePayload = {
      state: "sucesso",
      confidence: "high",
      limitations: ["W_STALE_INDEX"],
      items: [
        { path: "src/a.ts", name: "Alpha" },
        { path: "src/a.ts", name: "AlphaDup" },
        { path: "src/b.ts", name: "Beta" },
        { path: "src/b.ts", name: "BetaDup" },
      ],
    };

    const originalTokens = countTokens(JSON.stringify(smallPayload));
    expect(originalTokens).toBeLessThan(MIN_TOKENS_TO_COMPRESS);

    const result = compressPayload(smallPayload, "explore");

    // Prova ancorada: envelope pequeno sai idêntico (mesma referência ou idêntico sem _paths)
    expect(result).toBe(smallPayload);
    expect((result as Record<string, unknown>)._paths).toBeUndefined();
  });

  it("§7.2: payload grande cuja transformação infla sai igual ao original", () => {
    // Cria payload com >= 250 tokens onde substituir caminhos curtos por $0, $1 e adicionar _paths infla o payload
    // Caminhos curtíssimos ("a", "b") repetidos 2x viram "$0", "$1" (mais longos) + overhead da tabela _paths
    // E muitos campos preenchidos sem nenhum campo vazio para elisão compensar
    const textChunk = "Invariante verificavel de teste do gate de compressao que preenche espaco de tokens ".repeat(15);
    const inflatingPayload: ToolResponsePayload = {
      state: "sucesso",
      confidence: "high",
      limitations: ["W_PARTIAL_COVERAGE"],
      fill: textChunk,
      items: [
        { path: "a", val: 1 },
        { path: "a", val: 2 },
        { path: "b", val: 3 },
        { path: "b", val: 4 },
      ],
    };

    const originalTokens = countTokens(JSON.stringify(inflatingPayload));
    expect(originalTokens).toBeGreaterThanOrEqual(MIN_TOKENS_TO_COMPRESS);

    const result = compressPayload(inflatingPayload, "explore");

    const resultTokens = countTokens(JSON.stringify(result));
    // Prova ancorada: assert de tamanho medido (saída <= entrada) e devolução do payload original
    expect(resultTokens).toBeLessThanOrEqual(originalTokens);
    expect(result).toBe(inflatingPayload);
    expect((result as Record<string, unknown>)._paths).toBeUndefined();
  });

  it("§7.3: payload grande e compressível sai comprimido com redução medida", () => {
    // Payload grande com caminhos longos repetidos muitas vezes e campos vazios
    const longPath1 = "packages/argus/src/very/long/nested/directory/structure/module-alpha.ts";
    const longPath2 = "packages/argus/src/very/long/nested/directory/structure/module-beta.ts";

    const items = [];
    for (let i = 0; i < 20; i++) {
      items.push({
        path: longPath1,
        index: i,
        emptyList: [],
        emptyStr: "",
        emptyObj: {},
        nilVal: null,
      });
      items.push({
        path: longPath2,
        index: i,
        emptyList: [],
        emptyStr: "",
        emptyObj: {},
        nilVal: null,
      });
    }

    const compressiblePayload: ToolResponsePayload = {
      state: "sucesso",
      confidence: "high",
      limitations: ["W_STALE_INDEX"],
      items,
    };

    const originalTokens = countTokens(JSON.stringify(compressiblePayload));
    expect(originalTokens).toBeGreaterThanOrEqual(MIN_TOKENS_TO_COMPRESS);

    const result = compressPayload(compressiblePayload, "explore");
    const resultTokens = countTokens(JSON.stringify(result));

    // Prova ancorada: redução medida de tokens e presença da tabela de paths
    expect(resultTokens).toBeLessThan(originalTokens);
    expect((result as Record<string, unknown>)._paths).toEqual([longPath1, longPath2]);
  });

  it("§7.4: shape do envelope (state, confidence, limitations) preservado em todas as saídas", () => {
    // 1. Cenário pequeno (< 250)
    const pSmall: ToolResponsePayload = {
      state: "sucesso",
      confidence: "high",
      limitations: ["W_STALE_INDEX"],
      data: "hello",
    };
    const rSmall = compressPayload(pSmall, "explore");
    expect(rSmall.state).toBe("sucesso");
    expect(rSmall.confidence).toBe("high");
    expect(rSmall.limitations).toEqual(["W_STALE_INDEX"]);

    // 2. Cenário grande inflado
    const pInflate: ToolResponsePayload = {
      state: "parcial",
      confidence: "medium",
      limitations: ["W_PARTIAL_COVERAGE"],
      fill: "Token padding string to ensure size exceeds gate threshold ".repeat(25),
      items: [{ path: "a" }, { path: "a" }, { path: "b" }, { path: "b" }],
    };
    const rInflate = compressPayload(pInflate, "explore");
    expect(rInflate.state).toBe("parcial");
    expect(rInflate.confidence).toBe("medium");
    expect(rInflate.limitations).toEqual(["W_PARTIAL_COVERAGE"]);

    // 3. Cenário grande comprimido
    const longPath = "packages/argus/src/deeply/nested/long/path/for/compression/test.ts";
    const pCompress: ToolResponsePayload = {
      state: "ambigua",
      confidence: "low",
      limitations: ["W_MULTIPLE_MATCHES"],
      fill: "Padding ".repeat(20),
      items: Array.from({ length: 15 }, (_, i) => ({ path: longPath, idx: i, emptyArr: [] })),
    };
    const rCompress = compressPayload(pCompress, "explore");
    expect(rCompress.state).toBe("ambigua");
    expect(rCompress.confidence).toBe("low");
    expect(rCompress.limitations).toEqual(["W_MULTIPLE_MATCHES"]);
  });
});
