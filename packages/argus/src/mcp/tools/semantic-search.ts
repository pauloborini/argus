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
import { VaultEngine } from "../../memory/vault-engine.js";
import { WORKSPACE_MISSING, STALE_RUN_EMBED } from "./common.js";
import type { IndexEnvelope, SearchCandidate, ToolResponsePayload } from "./common.js";

export interface SemanticSearchArgs {
  query?: string;
  limit?: number;
  mode?: "dense" | "hybrid";
  domain?: "code" | "memory" | "all";
  scope?: string;
  kind?: string;
}

export interface SemanticSearchDeps {
  embedder?: Embedder;
}

interface MemoryCandidateChunk {
  note_id: string;
  title: string;
  path: string;
  score: number;
  snippet?: string;
  mechanism?: string;
  confidence?: string;
  stale_reason?: string;
  contradiction_reason?: string;
  superseded_by?: string;
}

function memoryToCandidate(chunk: MemoryCandidateChunk): SearchCandidate {
  const mechanism = chunk.mechanism ?? "memory";
  const candidate: SearchCandidate = {
    id: `note:${chunk.note_id}`,
    kind: "note",
    name: chunk.title,
    path: chunk.path,
    start_line: 1,
    end_line: 1,
    score: chunk.score,
    match_reason: mechanism,
  };
  if (chunk.confidence) {
    candidate.confidence = chunk.confidence;
  }
  if (chunk.stale_reason) {
    candidate.stale_reason = chunk.stale_reason;
  }
  if (chunk.contradiction_reason) {
    candidate.contradiction_reason = chunk.contradiction_reason;
  }
  if (chunk.superseded_by) {
    candidate.superseded_by = chunk.superseded_by;
  }
  return candidate;
}

function mapMemoryCandidates(chunks: MemoryCandidateChunk[] | undefined): SearchCandidate[] {
  return (chunks ?? []).map(memoryToCandidate);
}

function fuseCodeAndMemoryCandidates(
  codeCandidates: SearchCandidate[],
  memoryCandidates: SearchCandidate[],
  limit: number,
): SearchCandidate[] {
  const codeIds = codeCandidates.map((candidate) => candidate.id);
  const memoryIds = memoryCandidates.map((candidate) => candidate.id);
  const byId = new Map([...codeCandidates, ...memoryCandidates].map((candidate) => [candidate.id, candidate]));
  const fused = reciprocalRankFusion([codeIds, memoryIds])
    .slice(0, limit)
    .map((item) => byId.get(String(item.id)))
    .filter((candidate): candidate is SearchCandidate => candidate !== undefined);
  for (let rank = 0; rank < fused.length; rank += 1) {
    fused[rank] = { ...fused[rank]!, score: Number((1 / (rank + 1)).toFixed(4)) };
  }
  return fused;
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

function codeEnvelopeUnavailable(envelope: IndexEnvelope): boolean {
  return envelope.state === "falha" || !envelope.structuralIndex;
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
  const domain = args?.domain ?? "code";
  if (!query) {
    return {
      candidates: [],
      storage_backend: envelope.storage_backend,
      schema_version: envelope.schema_version,
      ...stubResponse("falha", "Input inválido para a tool"),
    };
  }
  const metadata = readWorkspaceMetadata(cwd);
  if (!metadata) {
    return invalidWorkspace(envelope);
  }

  if (domain === "memory") {
    const memory = await VaultEngine.recall(query, { limit: args?.limit ?? 20 }, metadata.root_path, deps?.embedder);
    return {
      candidates: mapMemoryCandidates(memory.chunks as MemoryCandidateChunk[] | undefined),
      storage_backend: envelope.storage_backend,
      schema_version: envelope.schema_version,
      mechanism: memory.mechanism,
      ...stubResponse(memory.state === "falha" ? "falha" : memory.state === "parcial" ? "parcial" : "sucesso", "Busca semântica no cofre concluída.", {
        limitations: memory.limitations,
      }),
    };
  }

  if (codeEnvelopeUnavailable(envelope) && domain === "all") {
    const memory = await VaultEngine.recall(query, { limit: args?.limit ?? 20 }, metadata.root_path, deps?.embedder);
    return {
      candidates: mapMemoryCandidates(memory.chunks as MemoryCandidateChunk[] | undefined),
      storage_backend: envelope.storage_backend,
      schema_version: envelope.schema_version,
      domain,
      memory: { state: memory.state, mechanism: memory.mechanism },
      ...stubResponse("parcial", "Busca limitada ao cofre; índice de código indisponível.", {
        limitations: [...(envelope.limitations ?? []), ...((memory.limitations as string[] | undefined) ?? [])],
      }),
    };
  }

  if (codeEnvelopeUnavailable(envelope)) {
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

  const db = openIndexDb(getIndexDbPath(metadata.root_path), { readonly: true });
  try {
    const limit = args?.limit ?? 20;
    const mode = args?.mode ?? "hybrid";
    const filters = { scope: args?.scope?.trim().toLowerCase(), kind: args?.kind?.trim().toLowerCase() };

    if (!hasEmbeddings(db)) {
      const codeCandidates = lexicalCandidates(db, query, limit, filters);
      if (domain === "all") {
        const memoryState = await VaultEngine.recall(query, { limit }, metadata.root_path, deps?.embedder);
        const memoryCandidates = mapMemoryCandidates(memoryState.chunks as MemoryCandidateChunk[] | undefined);
        const fused = fuseCodeAndMemoryCandidates(codeCandidates, memoryCandidates, limit);
        return {
          candidates: fused,
          storage_backend: envelope.storage_backend,
          schema_version: envelope.schema_version,
          domain,
          memory: { state: memoryState.state, mechanism: memoryState.mechanism },
          ...stubResponse("parcial", EMBEDDINGS_UNAVAILABLE, {
            limitations: [
              "Busca semântica indisponível; fallback lexical. Execute argus embed.",
              ...((memoryState.limitations as string[] | undefined) ?? []),
            ],
            staleness_hint: EMBEDDINGS_HINT,
          }),
        };
      }
      return {
        candidates: codeCandidates,
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
        const codeCandidates = lexicalCandidates(db, query, limit, filters);
        if (domain === "all") {
          const memoryState = await VaultEngine.recall(query, { limit }, metadata.root_path, deps?.embedder);
          const memoryCandidates = mapMemoryCandidates(memoryState.chunks as MemoryCandidateChunk[] | undefined);
          const fused = fuseCodeAndMemoryCandidates(codeCandidates, memoryCandidates, limit);
          return {
            candidates: fused,
            storage_backend: envelope.storage_backend,
            schema_version: envelope.schema_version,
            domain,
            memory: { state: memoryState.state, mechanism: memoryState.mechanism },
            ...stubResponse("parcial", err.message, {
              limitations: [
                "Modelo de embedding indisponível; fallback lexical.",
                ...((memoryState.limitations as string[] | undefined) ?? []),
              ],
              staleness_hint: EMBEDDINGS_HINT,
            }),
          };
        }
        return {
          candidates: codeCandidates,
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

    let finalCandidates = candidates;
    let memoryState: ToolResponsePayload | null = null;
    let responseState: "sucesso" | "parcial" | "stale" = stale ? "stale" : "sucesso";
    const responseLimitations: string[] = stale
      ? ["Embeddings defasados; refresque com argus embed."]
      : [];
    if (domain === "all") {
      memoryState = await VaultEngine.recall(query, { limit }, metadata.root_path, deps?.embedder);
      const memoryCandidates = mapMemoryCandidates(memoryState.chunks as MemoryCandidateChunk[] | undefined);
      finalCandidates = fuseCodeAndMemoryCandidates(candidates, memoryCandidates, limit);
      if (memoryState.state === "parcial") {
        responseState = "parcial";
        responseLimitations.push(...((memoryState.limitations as string[] | undefined) ?? []));
      }
    }

    return {
      candidates: finalCandidates,
      storage_backend: envelope.storage_backend,
      schema_version: envelope.schema_version,
      domain,
      memory: memoryState ? { state: memoryState.state, mechanism: memoryState.mechanism } : undefined,
      ...stubResponse(
        responseState,
        stale
          ? EMBEDDINGS_STALE
          : finalCandidates.length > 0
            ? "Busca semântica concluída."
            : "Nenhum candidato semântico encontrado.",
        responseLimitations.length
          ? { limitations: responseLimitations, staleness_hint: stale ? EMBEDDINGS_HINT : undefined }
          : stale
            ? { limitations: ["Embeddings defasados; refresque com argus embed."], staleness_hint: EMBEDDINGS_HINT }
            : undefined,
      ),
    };
  } finally {
    closeIndexDb(db);
  }
}
