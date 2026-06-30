// Tool `search`: busca FTS de símbolos com scoring e match-reason.
import { stubResponse } from "../../contracts/response-state.js";
import type { ResponseState } from "../../contracts/response-state.js";
import { closeIndexDb, openIndexDb, readLanguagesForPaths, searchFtsInternal } from "../../storage/sqlite-index-store.js";
import { getIndexDbPath, readWorkspaceMetadata } from "../../workspace/workspace.js";
import { STALE_INDEX, WORKSPACE_MISSING } from "./common.js";
import type { ToolResponsePayload, SearchArgs, IndexEnvelope, SearchCandidate } from "./common.js";

function scoreCandidate(rank: number, reason: string, relativePath: string): number {
  const reasonWeight: Record<string, number> = {
    name_exact: 1,
    name_prefix: 0.9,
    name_token: 0.8,
    path_token: 0.65,
    kind_token: 0.5,
    fts_match: 0.4,
  };
  const bm25Boost = Number.isFinite(rank) ? Math.min(0.09, Math.max(0, -rank / 100)) : 0;
  const pathPenalty = Math.min(0.08, relativePath.split("/").length * 0.005);
  return Number(Math.max(0, (reasonWeight[reason] ?? 0.3) + bm25Boost - pathPenalty).toFixed(4));
}

function inferMatchReason(query: string, name: string, relativePath: string, kind: string): string {
  const normalizedQuery = query.trim().toLowerCase();
  if (name.toLowerCase() === normalizedQuery) {
    return "name_exact";
  }
  if (name.toLowerCase().startsWith(normalizedQuery)) {
    return "name_prefix";
  }
  if (name.toLowerCase().includes(normalizedQuery)) {
    return "name_token";
  }
  if (relativePath.toLowerCase().includes(normalizedQuery)) {
    return "path_token";
  }
  if (kind.toLowerCase().includes(normalizedQuery)) {
    return "kind_token";
  }
  return "fts_match";
}

function buildSearchState(query: string, candidates: SearchCandidate[]): ResponseState {
  if (candidates.length < 2) {
    return "sucesso";
  }

  const normalizedQuery = query.trim().toLowerCase();
  const [first, second] = candidates;
  if (
    first &&
    second &&
    first.name.toLowerCase() === normalizedQuery &&
    second.name.toLowerCase() === normalizedQuery
  ) {
    return "ambigua";
  }

  return "sucesso";
}

export function buildSearchResponse(
  cwd: string,
  envelope: IndexEnvelope,
  args?: SearchArgs,
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

  // Com índice estrutural presente, sempre consultamos. Staleness "unknown"
  // (ex.: repo grande com limitações de discovery, ou sem git) é aviso suave,
  // não motivo para suprimir resultados: o índice persistido continua válido.
  // Suprimir tudo deixava search inútil em codebases reais grandes — o alvo do
  // produto. O sinal de incerteza é propagado no estado/limitations abaixo.

  const metadata = readWorkspaceMetadata(cwd);
  if (!metadata) {
    return {
      candidates: [],
      storage_backend: envelope.storage_backend,
      schema_version: envelope.schema_version,
      ...stubResponse("falha", WORKSPACE_MISSING),
    };
  }

  const db = openIndexDb(getIndexDbPath(metadata.root_path), { readonly: true });
  try {
    const requestedLimit = args?.limit ?? 20;
    const scope = args?.scope?.trim().toLowerCase();
    const kind = args?.kind?.trim().toLowerCase();
    const rawHits = searchFtsInternal(db, query, Math.min(100, requestedLimit * 4), {
      scope,
      kind,
    });
    const candidates: SearchCandidate[] = rawHits
      .map((hit) => {
        const matchReason = inferMatchReason(query, hit.name, hit.relative_path, hit.kind);
        return {
          id: `symbol:${hit.symbol_id}`,
          kind: hit.kind,
          name: hit.name,
          path: hit.relative_path,
          start_line: hit.start_line,
          end_line: hit.end_line,
          score: scoreCandidate(hit.rank, matchReason, hit.relative_path),
          match_reason: matchReason,
        };
      })
      .sort(
        (left, right) =>
          right.score - left.score ||
          left.name.localeCompare(right.name) ||
          left.path.localeCompare(right.path) ||
          left.start_line - right.start_line,
      )
      .slice(0, requestedLimit);

    // Cobertura por candidato sem o full-load: resolve language dos paths
    // candidatos por query alvo e cruza com coverage_by_language do meta.
    const coverageByLanguage = envelope.structuralIndex?.coverage_by_language ?? {};
    const languageByPath = readLanguagesForPaths(
      db,
      candidates.map((candidate) => candidate.path),
    );
    const partialCoverage = candidates.some((candidate) => {
      const language = languageByPath.get(candidate.path);
      return language ? coverageByLanguage[language]?.coverage_level === "partial" : false;
    });
    const baseState = buildSearchState(query, candidates);
    // O envelope sempre chega "parcial" (até fresh usa FTS_RETRIEVAL_PENDING).
    // O sinal real de incerteza é staleness indeterminada (message STALE_INDEX),
    // não o estado parcial genérico do envelope.
    const indexUncertain = envelope.message === STALE_INDEX;
    const state =
      envelope.state === "stale"
        ? "stale"
        : baseState === "ambigua"
          ? "ambigua"
          : partialCoverage || indexUncertain
            ? "parcial"
            : baseState;
    const message =
      candidates.length > 0
        ? state === "ambigua"
          ? "Múltiplos candidatos equivalentes encontrados; refine a query se precisar."
          : "Busca FTS concluída com candidatos indexados."
        : "Nenhum candidato encontrado no índice atual.";

    return {
      candidates,
      storage_backend: envelope.storage_backend,
      schema_version: envelope.schema_version,
      ...stubResponse(state, message, {
        limitations:
          envelope.state === "stale"
            ? envelope.limitations
            : indexUncertain
              ? envelope.limitations
              : partialCoverage
                ? ["Cobertura parcial para pelo menos uma das linguagens encontradas; refine ou valide o alvo antes de mudanças críticas."]
                : undefined,
        staleness_hint: envelope.staleness_hint,
      }),
    };
  } finally {
    closeIndexDb(db);
  }
}
