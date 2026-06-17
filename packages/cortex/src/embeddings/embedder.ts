// Abstração de embedder. O adapter real carrega o modelo bge-small via
// transformers.js (WASM, sem build nativo) de forma preguiçosa; o `FakeEmbedder`
// determinístico cobre os testes sem rede. Falha de load/dep degrada honesto
// via `EmbeddingsUnavailableError`, sem derrubar as outras tools.

export const DEFAULT_EMBEDDING_MODEL = "Xenova/bge-small-en-v1.5";
export const DEFAULT_EMBEDDING_DIM = 384;

// bge usa uma instrução de query no lado da busca (assimétrico query/documento).
// Documentos são embeddados crus; a query ganha este prefixo.
export const BGE_QUERY_INSTRUCTION = "Represent this sentence for searching relevant passages: ";

export interface Embedder {
  readonly model: string;
  readonly dim: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}

export class EmbeddingsUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbeddingsUnavailableError";
  }
}

// Forma mínima da saída do pipeline transformers.js que consumimos.
interface FeatureTensor {
  tolist(): number[][] | number[];
}
type FeaturePipeline = (
  texts: string[],
  options: { pooling: "mean"; normalize: boolean },
) => Promise<FeatureTensor>;
interface TransformersModule {
  pipeline(task: "feature-extraction", model: string): Promise<FeaturePipeline>;
}

/**
 * Embedder real: carrega transformers.js sob demanda e roda
 * feature-extraction com mean-pool + L2-normalize. O modelo baixa no 1º uso
 * (cache do transformers.js). Erros de import/load viram
 * `EmbeddingsUnavailableError`.
 */
export function createEmbedder(model: string = DEFAULT_EMBEDDING_MODEL): Embedder {
  let pipelinePromise: Promise<FeaturePipeline> | null = null;

  async function getPipeline(): Promise<FeaturePipeline> {
    if (!pipelinePromise) {
      pipelinePromise = (async () => {
        let mod: TransformersModule;
        try {
          mod = (await import("@huggingface/transformers")) as unknown as TransformersModule;
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          throw new EmbeddingsUnavailableError(
            `W_EMBEDDINGS_UNAVAILABLE: dependência @huggingface/transformers indisponível (${detail}).`,
          );
        }
        try {
          return await mod.pipeline("feature-extraction", model);
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          throw new EmbeddingsUnavailableError(
            `W_EMBEDDINGS_UNAVAILABLE: falha ao carregar o modelo ${model} (${detail}).`,
          );
        }
      })();
    }
    return pipelinePromise;
  }

  return {
    model,
    dim: DEFAULT_EMBEDDING_DIM,
    async embed(texts: string[]): Promise<Float32Array[]> {
      if (texts.length === 0) {
        return [];
      }
      const extractor = await getPipeline();
      const tensor = await extractor(texts, { pooling: "mean", normalize: true });
      const list = tensor.tolist();
      const rows = (Array.isArray(list[0]) ? list : [list]) as number[][];
      return rows.map((row) => Float32Array.from(row));
    },
  };
}

/**
 * Embedder determinístico para testes: projeta tokens do texto em buckets de um
 * vetor de dimensão fixa e L2-normaliza. Mesma entrada → mesmo vetor, sem rede.
 * Textos com tokens em comum ficam mais próximos por cosine.
 */
export class FakeEmbedder implements Embedder {
  readonly model = "fake-deterministic";
  constructor(readonly dim: number = 64) {}

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((text) => this.embedOne(text));
  }

  private embedOne(text: string): Float32Array {
    const vector = new Float32Array(this.dim);
    const tokens = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
    for (const token of tokens) {
      let hash = 2166136261;
      for (let i = 0; i < token.length; i += 1) {
        hash = Math.imul(hash ^ token.charCodeAt(i), 16777619);
      }
      const bucket = Math.abs(hash) % this.dim;
      vector[bucket] += 1;
    }
    let norm = 0;
    for (const value of vector) {
      norm += value * value;
    }
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (let i = 0; i < vector.length; i += 1) {
        vector[i] /= norm;
      }
    }
    return vector;
  }
}
