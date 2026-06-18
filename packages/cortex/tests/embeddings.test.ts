import { describe, expect, it } from "vitest";
import { FakeEmbedder } from "../src/embeddings/embedder.js";
import { blobToInt8, cosineInt8, int8ToBlob, quantizeInt8 } from "../src/embeddings/quantize.js";
import { reciprocalRankFusion } from "../src/embeddings/rrf.js";
import { denseTopK } from "../src/embeddings/vector-search.js";
import { buildChunkText, MAX_CHUNK_CHARS } from "../src/embeddings/chunk-text.js";

describe("quantize int8", () => {
  it("roundtrip BLOB preserva os bytes", () => {
    const { bytes } = quantizeInt8(Float32Array.from([0.1, -0.5, 0.9, 0]));
    const restored = blobToInt8(int8ToBlob(bytes));
    expect(Array.from(restored)).toEqual(Array.from(bytes));
  });

  it("cosine de um vetor consigo mesmo ~1; ortogonal ~0", () => {
    const a = quantizeInt8(Float32Array.from([1, 0, 0, 0])).bytes;
    const b = quantizeInt8(Float32Array.from([0, 1, 0, 0])).bytes;
    expect(cosineInt8(a, a)).toBeCloseTo(1, 5);
    expect(cosineInt8(a, b)).toBeCloseTo(0, 5);
  });

  it("vetor nulo retorna cosine 0", () => {
    const zero = quantizeInt8(Float32Array.from([0, 0, 0])).bytes;
    const v = quantizeInt8(Float32Array.from([1, 2, 3])).bytes;
    expect(cosineInt8(zero, v)).toBe(0);
  });
});

describe("reciprocal rank fusion", () => {
  it("item bem rankeado em ambas as listas vence", () => {
    const fused = reciprocalRankFusion([
      [10, 20, 30],
      [10, 40, 50],
    ]);
    expect(fused[0].id).toBe(10);
  });

  it("preserva ids exclusivos de cada lista", () => {
    const fused = reciprocalRankFusion([[1, 2], [3]]);
    const ids = fused.map((f) => f.id).sort((a, b) => a - b);
    expect(ids).toEqual([1, 2, 3]);
  });
});

describe("denseTopK", () => {
  it("rankeia por cosine e respeita o filtro allow", () => {
    const q = quantizeInt8(Float32Array.from([1, 0, 0])).bytes;
    const rows = [
      { symbol_id: 1, bytes: quantizeInt8(Float32Array.from([1, 0, 0])).bytes },
      { symbol_id: 2, bytes: quantizeInt8(Float32Array.from([0, 1, 0])).bytes },
      { symbol_id: 3, bytes: quantizeInt8(Float32Array.from([0.9, 0.1, 0])).bytes },
    ];
    const top = denseTopK(rows, q, 2);
    expect(top[0].symbol_id).toBe(1);
    expect(top.map((h) => h.symbol_id)).not.toContain(2);

    const filtered = denseTopK(rows, q, 5, new Set([2, 3]));
    expect(filtered.map((h) => h.symbol_id).sort()).toEqual([2, 3]);
  });
});

describe("FakeEmbedder", () => {
  it("é determinístico e aproxima textos com tokens em comum", async () => {
    const embedder = new FakeEmbedder();
    const [a1] = await embedder.embed(["retry backoff resubscribe"]);
    const [a2] = await embedder.embed(["retry backoff resubscribe"]);
    expect(Array.from(a1)).toEqual(Array.from(a2));

    const [shared] = await embedder.embed(["retry backoff handler"]);
    const [disjoint] = await embedder.embed(["completely different tokens here"]);
    const qa = quantizeInt8(a1).bytes;
    expect(cosineInt8(qa, quantizeInt8(shared).bytes)).toBeGreaterThan(
      cosineInt8(qa, quantizeInt8(disjoint).bytes),
    );
  });
});

describe("buildChunkText", () => {
  it("prefixa cabeçalho estrutural + corpo no range", () => {
    const text = buildChunkText(
      "src/a.ts",
      { name: "foo", kind: "function", start_line: 2, end_line: 3 },
      ["linha1", "function foo() {", "  return 1;", "}"],
    );
    expect(text).toContain("src/a.ts foo function");
    expect(text).toContain("function foo() {");
    expect(text).toContain("return 1;");
    expect(text).not.toContain("linha1");
  });

  it("trunca em MAX_CHUNK_CHARS", () => {
    const big = "x".repeat(5000);
    const text = buildChunkText(
      "f.ts",
      { name: "n", kind: "k", start_line: 1, end_line: 1 },
      [big],
    );
    expect(text.length).toBe(MAX_CHUNK_CHARS);
  });
});
