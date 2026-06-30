// Tool `semantic_search`: busca densa (bge-small) + fusão híbrida RRF com o
// lexical BM25. Off-by-default — depende de `argus embed` ter populado os
// vetores. Sem embeddings → degrada honesto (W_EMBEDDINGS_UNAVAILABLE) e cai
// para resultados lexicais, mantendo a tool útil. Embeddings stale (índice
// estrutural mudou desde o embed) → resultados servidos com state `stale`.
import { stubResponse } from "../../contracts/response-state.js";
import { BGE_QUERY_INSTRUCTION, createEmbedder, EmbeddingsUnavailableError, type Embedder } from "../../embeddings/embedder.js";
import { quantizeInt8 } from "../../embeddings/quantize.js";
import { reciprocalRankFusion } from "../../embeddings/rrf.js";
import { denseTopK } from "../../embeddings/vector-search.js";
import {
  hasEmbeddings,
  readAllEmbeddings,
  readEmbeddingsMeta,
  readSymbolsByIds,
  type SymbolDetail,
} from "../../storage/embeddings-store.js";
import {
  closeIndexDb,
  openIndexDb,
  readIndexMeta,
  searchFtsInternal,
} from "../../storage/sqlite-index-store.js";
import { getIndexDbPath, readWorkspaceMetadata } from "../../workspace/workspace.js";
import { WORKSPACE_MISSING, STALE_RUN_EMBED } from "./common.js";
import type { IndexEnvelope, SearchCandidate, ToolResponsePayload } from "./common.js";

export interface SemanticSearchArgs {
  query?: string;
  limit?: number;
  mode?: "dense" | "hybrid";
  scope?: string;
  kind?: string;
}

export interface SemanticSearchDeps {
  embedder?: Embedder;
}

const EMBEDDINGS_UNAVAILABLE =
  "W_EMBEDDINGS_UNAVAILABLE: Índice de embeddings ausente; execute argus embed. Resultados lexicais como fallback.";
const EMBEDDINGS_STALE =
  "W_EMBEDDINGS_STALE: Embeddings defasados em relação ao índice; execute argus embed.";
const EMBEDDINGS_HINT = `${STALE_RUN_EMBED}: Execute argus embed para (re)gerar os vetores semânticos.`;

function toCandidate(detail: SymbolDetail, score: number, reason: string): SearchCandidate {
  return {
    id: `symbol:${detail.symbol_id}`,
    kind: detail.kind,
    name: detail.name,
    path: detail.relative_path,
    start_line: detail.start_line,
    end_line: detail.end_line,
    score: Number(score.toFixed(4)),
    match_reason: reason,
  };
}

function lexicalCandidates(
  db: import("../../storage/sqlite-db.js").Database,
  query: string,
  limit: number,
  filters: { scope?: string; kind?: string },
): SearchCandidate[] {
  const hits = searchFtsInternal(db, query, limit, filters);
  return hits.map((hit, index) =>
    toCandidate(
      {
        symbol_id: hit.symbol_id,
        name: hit.name,
        kind: hit.kind,
        start_line: hit.start_line,
        end_line: hit.end_line,
        relative_path: hit.relative_path,
      },
      1 / (index + 1),
      "lexical",
    ),
  );
}

function invalidWorkspace(envelope: IndexEnvelope): ToolResponsePayload {
  return {
    candidates: [],
    storage_backend: envelope.storage_backend,
    schema_version: envelope.schema_version,
    ...stubResponse("falha", WORKSPACE_MISSING),
  };
}

/**
 * Caminho síncrono degradado: sem embeddar a query. Usado pelo dispatcher
 * síncrono (`buildToolResponse`) e quando os vetores estão ausentes — devolve
 * fallback lexical honesto. A busca densa real exige embed assíncrono e roda
 * por `buildSemanticSearchResponse`.
 */
export function buildSemanticSearchDegraded(
  cwd: string,
  envelope: IndexEnvelope,
  args?: SemanticSearchArgs,
): ToolResponsePayload {
  const query = args?.query?.trim() ?? "";
  if (!query) {
    return {
      candidates: [],
      storage_backend: envelope.storage_backend,
      schema_version: envelope.schema_version,
      ...stubResponse("falha", "Input inválido para a tool"),
    };
  }
  if (envelope.state === "falha" || !envelope.structuralIndex) {
    return {
      candidates: [],
      storage_backend: envelope.storage_backend,
      schema_version: envelope.schema_version,
      ...stubResponse(envelope.state, envelope.message, {
        limitations: envelope.limitations,
        staleness_hint: envelope.staleness_hint,
      }),
    };
  }

  const metadata = readWorkspaceMetadata(cwd);
  if (!metadata) {
    return invalidWorkspace(envelope);
  }

  const db = openIndexDb(getIndexDbPath(metadata.root_path), { readonly: true });
  try {
    const limit = args?.limit ?? 20;
    const filters = { scope: args?.scope?.trim().toLowerCase(), kind: args?.kind?.trim().toLowerCase() };
    const candidates = lexicalCandidates(db, query, limit, filters);
    return {
      candidates,
      storage_backend: envelope.storage_backend,
      schema_version: envelope.schema_version,
      ...stubResponse("parcial", EMBEDDINGS_UNAVAILABLE, {
        limitations: ["Busca semântica indisponível; fallback lexical. Execute argus embed."],
        staleness_hint: EMBEDDINGS_HINT,
      }),
    };
  } finally {
    closeIndexDb(db);
  }
}

/**
 * Busca semântica completa. `deps.embedder` injetável para teste; default é o
 * adapter real (transformers.js, lazy). Embeddings ausentes → degradado
 * lexical; presentes → dense (`mode: "dense"`) ou híbrido RRF (default).
 */
export async function buildSemanticSearchResponse(
  cwd: string,
  envelope: IndexEnvelope,
  args?: SemanticSearchArgs,
  deps?: SemanticSearchDeps,
): Promise<ToolResponsePayload> {
  const query = args?.query?.trim() ?? "";
  if (!query) {
    return {
      candidates: [],
      storage_backend: envelope.storage_backend,
      schema_version: envelope.schema_version,
      ...stubResponse("falha", "Input inválido para a tool"),
    };
  }
  if (envelope.state === "falha" || !envelope.structuralIndex) {
    return {
      candidates: [],
      storage_backend: envelope.storage_backend,
      schema_version: envelope.schema_version,
      ...stubResponse(envelope.state, envelope.message, {
        limitations: envelope.limitations,
        staleness_hint: envelope.staleness_hint,
      }),
    };
  }

  const metadata = readWorkspaceMetadata(cwd);
  if (!metadata) {
    return invalidWorkspace(envelope);
  }

  const db = openIndexDb(getIndexDbPath(metadata.root_path), { readonly: true });
  try {
    const limit = args?.limit ?? 20;
    const mode = args?.mode ?? "hybrid";
    const filters = { scope: args?.scope?.trim().toLowerCase(), kind: args?.kind?.trim().toLowerCase() };

    if (!hasEmbeddings(db)) {
      // Reusa o caminho degradado (fallback lexical) sem reabrir o DB.
      const candidates = lexicalCandidates(db, query, limit, filters);
      return {
        candidates,
        storage_backend: envelope.storage_backend,
        schema_version: envelope.schema_version,
        ...stubResponse("parcial", EMBEDDINGS_UNAVAILABLE, {
          limitations: ["Busca semântica indisponível; fallback lexical. Execute argus embed."],
          staleness_hint: EMBEDDINGS_HINT,
        }),
      };
    }

    // Embedda a query (com a instrução bge de busca). Falha de modelo/dep →
    // degrada honesto para lexical em vez de quebrar a tool.
    const embedder = deps?.embedder ?? createEmbedder();
    let queryVector: Float32Array;
    try {
      const [vec] = await embedder.embed([`${BGE_QUERY_INSTRUCTION}${query}`]);
      queryVector = vec;
    } catch (err) {
      if (err instanceof EmbeddingsUnavailableError) {
        const candidates = lexicalCandidates(db, query, limit, filters);
        return {
          candidates,
          storage_backend: envelope.storage_backend,
          schema_version: envelope.schema_version,
          ...stubResponse("parcial", err.message, {
            limitations: ["Modelo de embedding indisponível; fallback lexical."],
            staleness_hint: EMBEDDINGS_HINT,
          }),
        };
      }
      throw err;
    }

    const { bytes: queryBytes } = quantizeInt8(queryVector);
    const rows = readAllEmbeddings(db);
    const denseHits = denseTopK(rows, queryBytes, Math.max(limit, 50));

    let orderedIds: number[];
    const denseIds = denseHits.map((hit) => hit.symbol_id);
    const denseSet = new Set(denseIds);
    let lexicalSet = new Set<number>();

    if (mode === "dense") {
      orderedIds = denseIds.slice(0, limit);
    } else {
      const lexicalHits = searchFtsInternal(db, query, Math.max(limit, 50), filters);
      const lexicalIds = lexicalHits.map((hit) => hit.symbol_id);
      lexicalSet = new Set(lexicalIds);
      orderedIds = reciprocalRankFusion([denseIds, lexicalIds])
        .map((fused) => fused.id)
        .slice(0, limit);
    }

    const details = readSymbolsByIds(db, orderedIds);
    const denseScore = new Map(denseHits.map((hit) => [hit.symbol_id, hit.score]));
    const candidates: SearchCandidate[] = [];
    for (let rank = 0; rank < orderedIds.length; rank += 1) {
      const id = orderedIds[rank];
      const detail = details.get(id);
      if (!detail) {
        continue;
      }
      const inDense = denseSet.has(id);
      const inLexical = lexicalSet.has(id);
      const reason = mode === "dense" ? "semantic" : inDense && inLexical ? "hybrid" : inDense ? "semantic" : "lexical";
      // Score: cosine denso quando disponível, senão posição no ranking fundido.
      const score = denseScore.get(id) ?? 1 / (rank + 1);
      candidates.push(toCandidate(detail, score, reason));
    }

    // Staleness: índice estrutural mudou desde o embed → marca stale (serve).
    const indexMeta = readIndexMeta(db);
    const embMeta = readEmbeddingsMeta(db);
    const stale =
      indexMeta && embMeta ? indexMeta.manifest_hash !== embMeta.manifest_hash : false;

    return {
      candidates,
      storage_backend: envelope.storage_backend,
      schema_version: envelope.schema_version,
      ...stubResponse(
        stale ? "stale" : "sucesso",
        stale
          ? EMBEDDINGS_STALE
          : candidates.length > 0
            ? "Busca semântica concluída."
            : "Nenhum candidato semântico encontrado.",
        stale ? { limitations: ["Embeddings defasados; refresque com argus embed."], staleness_hint: EMBEDDINGS_HINT } : undefined,
      ),
    };
  } finally {
    closeIndexDb(db);
  }
}
