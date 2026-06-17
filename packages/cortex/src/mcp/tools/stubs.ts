import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { stubResponse } from "../../contracts/response-state.js";
import type { ResponseState } from "../../contracts/response-state.js";
import type { OperationalEnvelope } from "../../contracts/response-state.js";
import type { DiscoveryManifest } from "../../discovery/types.js";
import { ManifestCorruptedError, readManifest } from "../../discovery/manifest.js";
import { computeManifestStaleness } from "../../discovery/staleness.js";
import { readDirtyFlag } from "../../discovery/dirty-flag.js";
import type { FileTreeNode } from "../../extraction/files-tree.js";
import type { StructuralIndex } from "../../extraction/types.js";
import type { ExtractedSymbol, FileStructuralEntry } from "../../extraction/types.js";
import { STRUCTURAL_INDEX_SCHEMA_VERSION } from "../../extraction/types.js";
import {
  IndexDbCorruptedError,
  IndexDbSchemaError,
  loadStructuralIndexForRead,
  loadStructuralMetaForRead,
} from "../../storage/index-persistence.js";
import {
  closeIndexDb,
  openIndexDb,
  readFileTreeRows,
  readLanguagesForPaths,
  searchFtsInternal,
} from "../../storage/sqlite-index-store.js";
import type { FileTreeRow } from "../../storage/sqlite-index-store.js";
import { SQLITE_SCHEMA_VERSION } from "../../storage/sqlite-prepared.js";
import {
  getIndexDbPath,
  getManifestPath,
  readWorkspaceMetadata,
  resolveRespectGitignore,
} from "../../workspace/workspace.js";
import type { McpToolName } from "../tool-registry.js";

export interface ToolStubPayload extends OperationalEnvelope {
  [key: string]: unknown;
}

interface SearchArgs {
  query?: string;
  scope?: string;
  kind?: string;
  limit?: number;
}

interface FilesArgs {
  pattern?: string;
  max_depth?: number;
}

interface ExploreArgs {
  target?: string;
  mode?: "symbol" | "file" | "topic";
  depth?: number;
  include_tests?: boolean;
  budget?: number;
}

interface TraceArgs {
  from?: string;
  to?: string;
  direction?: "forward" | "backward" | "both";
  max_hops?: number;
}

interface ImpactArgs {
  target?: string;
  direction?: "dependents" | "dependencies" | "both";
  depth?: number;
  include_tests?: boolean;
  summary_only?: boolean;
}

interface DiffImpactArgs {
  scope?: "unstaged" | "staged" | "all" | "compare";
  base_ref?: string;
}

interface PackContextArgs {
  sources?: string[];
  goal?: string;
  token_budget?: number;
  style?: "brief" | "balanced" | "deep";
}

interface RetrieveArgs {
  handle?: string;
}

const INDEX_MISSING = "E_INDEX_MISSING: Índice não inicializado; execute init/index";
const STALE_INDEX = "E_STALE_INDEX: Índice desatualizado; resultados podem estar incompletos";
const WORKSPACE_MISSING =
  "E_WORKSPACE_INVALID: Workspace não preparado ou path inválido. Execute cortex init.";
const STRUCTURAL_INDEX_MISSING =
  "E_INDEX_MISSING: Manifest disponível; índice estrutural ausente — execute cortex index ou cortex sync.";
const FTS_RETRIEVAL_PENDING =
  "Índice lexical e estrutural disponível para retrieval local.";
const PARTIAL_NO_MANIFEST_LIMITATIONS = [
  "Manifest de arquivos ausente; execute cortex index para iniciar o inventário.",
];
const PARTIAL_CORRUPTED_MANIFEST_LIMITATIONS = [
  "Manifest de arquivos corrompido; execute cortex index para recriar o inventário.",
];
const PARTIAL_STRUCTURAL_MISSING_LIMITATIONS = [
  "Manifest presente, mas índice SQLite ausente; execute cortex index ou cortex sync.",
];
const PARTIAL_FTS_LIMITATIONS = [
  "Resultados dependem da cobertura estrutural disponível para cada linguagem.",
];
const PARTIAL_CORRUPTED_STRUCTURAL_LIMITATIONS = [
  "Índice SQLite corrompido; execute cortex index para reconstruir.",
];

interface SemanticStubEnvelope {
  state: ResponseState;
  message: string;
  limitations?: string[];
  staleness_hint?: string;
  structuralIndex: StructuralIndex | null;
  storage_backend: "sqlite" | null;
  schema_version: string | null;
}

interface SearchCandidate {
  id: string;
  kind: string;
  name: string;
  path: string;
  start_line: number;
  end_line: number;
  score: number;
  match_reason: string;
}

interface ExploreSnippetRef {
  path: string;
  start_line: number;
  end_line: number;
  symbol?: string;
}

interface ExploreRef {
  // Omitido para refs file-level (`name` seria idêntico a `path`); presente só
  // para refs de símbolo (callers/callees), onde carrega o nome do símbolo.
  name?: string;
  path: string;
  kind?: string;
  reason?: string;
}

interface TraceResolvedTarget {
  node?: TraceNode;
  candidates: ExploreRef[];
  limitations?: string[];
}

interface TraceNode {
  id: string;
  node_type: "symbol" | "file";
  name: string;
  path: string;
  symbol_kind?: string;
  line?: number;
}

interface TraceEdgeStep {
  relation: string;
  from: TraceNode;
  to: TraceNode;
  line?: number;
  uncertain?: string;
}

interface TraceHopPayload {
  relation: string;
  name: string;
  path: string;
  node_type: "symbol" | "file";
  symbol_kind?: string;
  line?: number;
}

interface TracePathPayload {
  hops: TraceHopPayload[];
  files: string[];
  symbols: string[];
}

interface TraceUncertaintyPoint {
  reason: string;
  path?: string;
  symbol?: string;
  relation?: string;
  detail?: string;
}

interface ImpactRef {
  name: string;
  path: string;
  node_type: "symbol" | "file";
  symbol_kind?: string;
  depth: number;
  relation?: string;
}

interface DiffImpactSymbol {
  name: string;
  path: string;
  kind?: string;
}

interface DiffChangedHunk {
  path: string;
  start_line: number;
  line_count: number;
}

interface PackOriginRef {
  ref: string;
  path: string;
  start_line?: number;
  end_line?: number;
  symbol?: string;
}

interface PackRemovedEntry {
  ref: string;
  action: "removed" | "summarized" | "deduplicated";
  reason: "budget" | "low_relevance" | "duplicate";
  recoverable: boolean;
  via_handle?: string;
}

interface PackSegment {
  ref: string;
  text: string;
  originRefs: PackOriginRef[];
}

interface StoredPackHandle {
  handle: string;
  created_at: string;
  goal: string;
  style: NonNullable<PackContextArgs["style"]>;
  token_budget: number;
  manifest_hash?: string | null;
  schema_version?: string | null;
  segments: Array<{
    ref: string;
    originRefs: PackOriginRef[];
    body_file: string;
  }>;
}

interface ReadStoredPackHandleResult {
  found: boolean;
  segments: PackSegment[];
  limitations: string[];
  reversibility: "full" | "partial" | "none";
}

interface SymbolRef {
  file: FileStructuralEntry;
  symbol: ExtractedSymbol;
}

type TraceNodeRef =
  | { type: "symbol"; file: FileStructuralEntry; symbol: ExtractedSymbol }
  | { type: "file"; file: FileStructuralEntry };

interface _TraceHop {
  relation: string;
  path: string;
  symbol?: string;
  kind?: string;
}

type StructuralLoadMode = "full" | "lite";

function loadStructuralIndex(
  rootPath: string,
  mode: StructuralLoadMode = "full",
): StructuralIndex | null {
  // `lite`: meta-only (files: []) para search/files, que resolvem cobertura e
  // tree por query alvo — evita o full-load (N+1 de símbolos/edges por arquivo).
  return mode === "lite"
    ? loadStructuralMetaForRead(rootPath)
    : loadStructuralIndexForRead(rootPath);
}

function mergeStructuralLimitations(
  structural: StructuralIndex | null,
  base: string[] = [],
): string[] {
  if (!structural?.extraction_limitations?.length) {
    return base;
  }
  return [...base, ...structural.extraction_limitations];
}

function buildIndexVersion(manifest: DiscoveryManifest, structural: StructuralIndex | null): string {
  if (structural) {
    return `${manifest.schema_version}+sqlite@${structural.schema_version}`;
  }
  return manifest.schema_version;
}

export function buildCoverageSummaryFromIndex(
  structural: StructuralIndex | null,
): Record<string, unknown> {
  if (!structural) {
    return {};
  }
  return structural.coverage_by_language;
}

function buildStatusStub(cwd: string): ToolStubPayload {
  const metadata = readWorkspaceMetadata(cwd);

  if (!metadata) {
    return {
      initialized: false,
      staleness: "unknown",
      pending_files_count: 0,
      coverage_by_language: {},
      index_version: null,
      storage_backend: null,
      schema_version: null,
      ...stubResponse("falha", WORKSPACE_MISSING),
    };
  }

  let manifest: DiscoveryManifest | null;
  try {
    manifest = readManifest(getManifestPath(metadata.root_path));
  } catch (err) {
    if (err instanceof ManifestCorruptedError) {
      return {
        initialized: true,
        staleness: "unknown",
        pending_files_count: 0,
        coverage_by_language: {},
        index_version: null,
        storage_backend: null,
        schema_version: null,
        ...stubResponse("parcial", err.message, {
          limitations: PARTIAL_CORRUPTED_MANIFEST_LIMITATIONS,
          staleness_hint: "Execute cortex index para reconstruir o manifest.",
        }),
      };
    }
    throw err;
  }

  if (!manifest) {
    return {
      initialized: true,
      staleness: "unknown",
      pending_files_count: 0,
      coverage_by_language: {},
      index_version: null,
      storage_backend: null,
      schema_version: null,
      ...stubResponse("parcial", INDEX_MISSING, {
        limitations: PARTIAL_NO_MANIFEST_LIMITATIONS,
        staleness_hint: "Execute cortex index para criar o manifest inicial.",
      }),
    };
  }

  let structural: StructuralIndex | null = null;
  try {
    structural = loadStructuralIndex(metadata.root_path);
  } catch (err) {
    if (err instanceof IndexDbCorruptedError || err instanceof IndexDbSchemaError) {
      return {
        initialized: true,
        staleness: "unknown",
        pending_files_count: 0,
        coverage_by_language: {},
        index_version: null,
        storage_backend: "sqlite",
        schema_version: null,
        ...stubResponse("falha", err.message, {
          limitations: PARTIAL_CORRUPTED_STRUCTURAL_LIMITATIONS,
          staleness_hint: "Execute cortex index para reconstruir o índice estrutural.",
        }),
      };
    }
    throw err;
  }

  const staleness = computeManifestStaleness(metadata.root_path, manifest, {
    respect_gitignore: resolveRespectGitignore(metadata),
  });
  const coverage = structural?.coverage_by_language ?? {};
  const dirtyFlag = readDirtyFlag(metadata.root_path);
  const basePayload = {
    initialized: true,
    staleness: staleness.staleness,
    pending_files_count: staleness.pending_files_count,
    coverage_by_language: coverage,
    index_version: buildIndexVersion(manifest, structural),
    storage_backend: structural ? ("sqlite" as const) : null,
    schema_version: structural?.schema_version ?? null,
    dirty_pending: dirtyFlag
      ? { paths: dirtyFlag.paths.length, force_full: dirtyFlag.force_full, since_ref: dirtyFlag.since_ref }
      : null,
  };

  if (!structural) {
    return {
      ...basePayload,
      ...stubResponse("parcial", STRUCTURAL_INDEX_MISSING, {
        limitations: PARTIAL_STRUCTURAL_MISSING_LIMITATIONS,
        staleness_hint: "Execute cortex index ou cortex sync para gerar o índice SQLite.",
      }),
    };
  }

  const structuralLimitations = mergeStructuralLimitations(structural);

  if (staleness.staleness === "fresh") {
    if (structuralLimitations.length > 0) {
      return {
        ...basePayload,
        ...stubResponse("parcial", "Índice estrutural atualizado com limitações de cobertura.", {
          limitations: structuralLimitations,
        }),
      };
    }

    return {
      ...basePayload,
      ...stubResponse("sucesso", "Índice de arquivos e extração estrutural atualizados (SQLite)."),
    };
  }

  if (staleness.staleness === "stale") {
    return {
      ...basePayload,
      ...stubResponse("stale", STALE_INDEX, {
        limitations: structuralLimitations,
        staleness_hint: "Execute cortex sync para sincronizar o delta pendente.",
      }),
    };
  }

  return {
    ...basePayload,
    ...stubResponse("parcial", STALE_INDEX, {
      limitations: mergeStructuralLimitations(structural, [
        "Não foi possível determinar staleness com segurança.",
      ]),
      staleness_hint: "Execute cortex sync se o filesystem mudou recentemente.",
    }),
  };
}

function buildSemanticStubEnvelope(
  cwd: string,
  mode: StructuralLoadMode = "full",
): SemanticStubEnvelope {
  const metadata = readWorkspaceMetadata(cwd);
  if (!metadata) {
    return {
      state: "falha",
      message: WORKSPACE_MISSING,
      structuralIndex: null,
      storage_backend: null,
      schema_version: null,
    };
  }

  let manifest: DiscoveryManifest | null;
  try {
    manifest = readManifest(getManifestPath(metadata.root_path));
  } catch (err) {
    if (err instanceof ManifestCorruptedError) {
      return {
        state: "parcial",
        message: err.message,
        limitations: PARTIAL_CORRUPTED_MANIFEST_LIMITATIONS,
        staleness_hint: "Execute cortex index para reconstruir o manifest.",
        structuralIndex: null,
        storage_backend: null,
        schema_version: null,
      };
    }
    throw err;
  }

  if (!manifest) {
    return {
      state: "parcial",
      message: INDEX_MISSING,
      limitations: PARTIAL_NO_MANIFEST_LIMITATIONS,
      staleness_hint: "Execute cortex index para criar o manifest inicial.",
      structuralIndex: null,
      storage_backend: null,
      schema_version: null,
    };
  }

  let structural: StructuralIndex | null = null;
  try {
    structural = loadStructuralIndex(metadata.root_path, mode);
  } catch (err) {
    if (err instanceof IndexDbCorruptedError || err instanceof IndexDbSchemaError) {
      return {
        state: "falha",
        message: err.message,
        limitations: PARTIAL_CORRUPTED_STRUCTURAL_LIMITATIONS,
        structuralIndex: null,
        storage_backend: "sqlite",
        schema_version: null,
      };
    }
    throw err;
  }

  const storage_backend = structural ? ("sqlite" as const) : null;
  const schema_version = structural?.schema_version ?? null;

  const staleness = computeManifestStaleness(metadata.root_path, manifest, {
    respect_gitignore: resolveRespectGitignore(metadata),
  });
  if (staleness.staleness === "stale") {
    return {
      state: "stale",
      message: STALE_INDEX,
      limitations: structural ? PARTIAL_FTS_LIMITATIONS : PARTIAL_STRUCTURAL_MISSING_LIMITATIONS,
      staleness_hint: "Execute cortex sync para sincronizar o delta pendente.",
      structuralIndex: structural,
      storage_backend,
      schema_version,
    };
  }

  if (staleness.staleness === "unknown") {
    return {
      state: "parcial",
      message: STALE_INDEX,
      limitations: structural ? PARTIAL_FTS_LIMITATIONS : PARTIAL_STRUCTURAL_MISSING_LIMITATIONS,
      staleness_hint: "Não foi possível determinar staleness com segurança.",
      structuralIndex: structural,
      storage_backend,
      schema_version,
    };
  }

  if (!structural) {
    return {
      state: "parcial",
      message: STRUCTURAL_INDEX_MISSING,
      limitations: PARTIAL_STRUCTURAL_MISSING_LIMITATIONS,
      staleness_hint: "Execute cortex index ou cortex sync para gerar o índice SQLite.",
      structuralIndex: null,
      storage_backend: null,
      schema_version: null,
    };
  }

  return {
    state: "parcial",
    message: FTS_RETRIEVAL_PENDING,
    limitations: mergeStructuralLimitations(structural, PARTIAL_FTS_LIMITATIONS),
    structuralIndex: structural,
    storage_backend,
    schema_version,
  };
}

/** Tree + languages a partir de linhas agregadas em SQL (sem materializar o grafo). */
function fileTreeFromRows(rows: FileTreeRow[]): { tree: FileTreeNode[]; languages: string[] } {
  const languages = new Set<string>();
  const tree: FileTreeNode[] = [];
  for (const row of rows) {
    if (row.language === "unsupported") {
      continue;
    }
    languages.add(row.language);
    // Arquivo com erro de parse não tem contagem confiável: zera (mesma
    // semântica de summarizeSymbolCounts).
    const counts = row.has_parse_errors
      ? { total: 0, functions: 0, classes: 0, other: 0 }
      : { total: row.total, functions: row.functions, classes: row.classes, other: row.other };
    tree.push({ path: row.relative_path, symbol_counts: counts });
  }
  return { tree, languages: [...languages].sort() };
}

function buildFilesStub(cwd: string, semanticStub: SemanticStubEnvelope): ToolStubPayload {
  const structural = semanticStub.structuralIndex;

  if (semanticStub.state === "falha" || !structural) {
    return {
      tree: [],
      languages: [],
      storage_backend: semanticStub.storage_backend,
      schema_version: semanticStub.schema_version,
      ...stubResponse(semanticStub.state, semanticStub.message, {
        limitations: semanticStub.limitations,
        staleness_hint: semanticStub.staleness_hint,
      }),
    };
  }

  const metadata = readWorkspaceMetadata(cwd);
  if (!metadata) {
    return {
      tree: [],
      languages: [],
      storage_backend: semanticStub.storage_backend,
      schema_version: semanticStub.schema_version,
      ...stubResponse("falha", WORKSPACE_MISSING),
    };
  }
  const db = openIndexDb(getIndexDbPath(metadata.root_path), { readonly: true });
  let tree: FileTreeNode[];
  let languages: string[];
  try {
    ({ tree, languages } = fileTreeFromRows(readFileTreeRows(db)));
  } finally {
    closeIndexDb(db);
  }

  if (semanticStub.state === "stale") {
    return {
      tree,
      languages,
      storage_backend: semanticStub.storage_backend,
      schema_version: semanticStub.schema_version,
      ...stubResponse("stale", semanticStub.message, {
        limitations: semanticStub.limitations,
        staleness_hint: semanticStub.staleness_hint,
      }),
    };
  }

  const structuralLimitations = mergeStructuralLimitations(structural);
  if (structuralLimitations.length > 0) {
    return {
      tree,
      languages,
      storage_backend: semanticStub.storage_backend,
      schema_version: semanticStub.schema_version,
      ...stubResponse("parcial", "Estrutura indexada com limitações de cobertura.", {
        limitations: structuralLimitations,
      }),
    };
  }

  return {
    tree,
    languages,
    storage_backend: semanticStub.storage_backend,
    schema_version: semanticStub.schema_version,
    ...stubResponse("sucesso", "Estrutura indexada com contagens de símbolos por arquivo."),
  };
}

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

function buildSearchStub(
  cwd: string,
  semanticStub: SemanticStubEnvelope,
  args?: SearchArgs,
): ToolStubPayload {
  const query = args?.query?.trim() ?? "";
  if (!query) {
    return {
      candidates: [],
      storage_backend: semanticStub.storage_backend,
      schema_version: semanticStub.schema_version,
      ...stubResponse("falha", "Input inválido para a tool"),
    };
  }

  if (semanticStub.state === "falha" || !semanticStub.structuralIndex) {
    return {
      candidates: [],
      storage_backend: semanticStub.storage_backend,
      schema_version: semanticStub.schema_version,
      ...stubResponse(semanticStub.state, semanticStub.message, {
        limitations: semanticStub.limitations,
        staleness_hint: semanticStub.staleness_hint,
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
      storage_backend: semanticStub.storage_backend,
      schema_version: semanticStub.schema_version,
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
    const coverageByLanguage = semanticStub.structuralIndex?.coverage_by_language ?? {};
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
    const indexUncertain = semanticStub.message === STALE_INDEX;
    const state =
      semanticStub.state === "stale"
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
      storage_backend: semanticStub.storage_backend,
      schema_version: semanticStub.schema_version,
      ...stubResponse(state, message, {
        limitations:
          semanticStub.state === "stale"
            ? semanticStub.limitations
            : indexUncertain
              ? semanticStub.limitations
              : partialCoverage
                ? ["Cobertura parcial para pelo menos uma das linguagens encontradas; refine ou valide o alvo antes de mudanças críticas."]
                : undefined,
        staleness_hint: semanticStub.staleness_hint,
      }),
    };
  } finally {
    closeIndexDb(db);
  }
}

function uniqueByKey<T>(items: T[], getKey: (item: T) => string): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    const key = getKey(item);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(item);
  }
  return result;
}

function fileMatchesTests(relativePath: string): boolean {
  return /(^|\/)(test|tests|__tests__)\//.test(relativePath) || /\.test\./.test(relativePath);
}

function buildSnippetRefs(
  entry: FileStructuralEntry,
  symbols: ExtractedSymbol[],
  limit: number,
): ExploreSnippetRef[] {
  return symbols.slice(0, limit).map((symbol) => ({
    path: entry.relative_path,
    start_line: symbol.start_line,
    end_line: symbol.end_line,
    symbol: symbol.name,
  }));
}

function collectFileRelevantFiles(
  index: StructuralIndex,
  entry: FileStructuralEntry,
  includeTests: boolean,
  budget: number,
): ExploreRef[] {
  const refs: ExploreRef[] = [
    { path: entry.relative_path, reason: "target_file" },
  ];

  for (const imported of entry.imports) {
    if (imported.resolved_path) {
      refs.push({
        path: imported.resolved_path,
        reason: "resolved_import",
      });
    }
  }

  for (const candidate of index.files) {
    if (candidate.relative_path === entry.relative_path) {
      continue;
    }
    if (!includeTests && fileMatchesTests(candidate.relative_path)) {
      continue;
    }
    if (candidate.imports.some((item) => item.resolved_path === entry.relative_path)) {
      refs.push({
        path: candidate.relative_path,
        reason: "importer_file",
      });
    }
  }

  return uniqueByKey(refs, (item) => `${item.path}:${item.reason ?? ""}`).slice(0, budget);
}

function collectCallersAndCallees(
  index: StructuralIndex,
  entry: FileStructuralEntry,
  targetSymbol: ExtractedSymbol | null,
  includeTests: boolean,
  budget: number,
): { callers: ExploreRef[]; callees: ExploreRef[] } {
  const targetName = targetSymbol?.name;
  const callees: ExploreRef[] = [];
  const callers: ExploreRef[] = [];

  for (const edge of entry.edges) {
    if (edge.kind === "calls") {
      callees.push({
        name: edge.to,
        path: entry.relative_path,
        kind: "calls",
        reason: targetName ? "file_level_call_context" : "file_calls",
      });
    }
  }

  if (targetName) {
    for (const candidate of index.files) {
      if (!includeTests && fileMatchesTests(candidate.relative_path)) {
        continue;
      }
      for (const edge of candidate.edges) {
        if (edge.kind === "calls" && edge.to === targetName) {
          callers.push({
            name: targetName,
            path: candidate.relative_path,
            kind: "calls",
            reason:
              candidate.relative_path === entry.relative_path
                ? "same_file_call_match"
                : "cross_file_call_match",
          });
        }
      }
    }
  }

  return {
    callers: uniqueByKey(callers, (item) => `${item.path}:${item.name}:${item.reason ?? ""}`).slice(
      0,
      budget,
    ),
    callees: uniqueByKey(callees, (item) => `${item.path}:${item.name}:${item.reason ?? ""}`).slice(
      0,
      budget,
    ),
  };
}

function selectFileTarget(
  index: StructuralIndex,
  target: string,
  includeTests: boolean,
): { entry: FileStructuralEntry | null; candidates: ExploreRef[] } {
  const normalized = target.trim().toLowerCase();
  const exact = index.files.filter(
    (file) =>
      file.relative_path.toLowerCase() === normalized &&
      (includeTests || !fileMatchesTests(file.relative_path)),
  );
  if (exact.length === 1) {
    return { entry: exact[0]!, candidates: [] };
  }
  const partial = index.files
    .filter(
      (file) =>
        file.relative_path.toLowerCase().includes(normalized) &&
        (includeTests || !fileMatchesTests(file.relative_path)),
    )
    .sort((a, b) => a.relative_path.localeCompare(b.relative_path));
  return {
    entry: partial.length === 1 ? partial[0]! : null,
    candidates: partial.slice(0, 10).map((file) => ({
      path: file.relative_path,
      reason: "file_match",
    })),
  };
}

function buildExploreSummary(
  targetLabel: string,
  entry: FileStructuralEntry,
  centralSymbols: ExtractedSymbol[],
  importsCount: number,
  callersCount: number,
  calleesCount: number,
): string {
  return `${targetLabel} em ${entry.relative_path}: ${centralSymbols.length} símbolo(s) centrais, ${importsCount} import(s), ${callersCount} caller(s) inferido(s) e ${calleesCount} callee(s) inferido(s).`;
}

function buildFileNode(entry: FileStructuralEntry): TraceNode {
  return {
    id: `file:${entry.relative_path}`,
    node_type: "file",
    name: entry.relative_path,
    path: entry.relative_path,
  };
}

function buildSymbolNode(entry: FileStructuralEntry, symbol: ExtractedSymbol): TraceNode {
  return {
    id: `symbol:${entry.relative_path}:${symbol.name}:${symbol.start_line}`,
    node_type: "symbol",
    name: symbol.name,
    path: entry.relative_path,
    symbol_kind: symbol.kind,
    line: symbol.start_line,
  };
}

function findFilesBySymbolName(
  index: StructuralIndex,
  symbolName: string,
  includeTests: boolean,
): Array<{ entry: FileStructuralEntry; symbol: ExtractedSymbol }> {
  const matches: Array<{ entry: FileStructuralEntry; symbol: ExtractedSymbol }> = [];
  for (const entry of index.files) {
    if (!includeTests && fileMatchesTests(entry.relative_path)) {
      continue;
    }
    for (const symbol of entry.symbols) {
      if (symbol.name === symbolName) {
        matches.push({ entry, symbol });
      }
    }
  }
  return matches;
}

function callTargetName(rawTarget: string): string {
  const segments = rawTarget.split(/[.:]/).filter(Boolean);
  return segments.at(-1) ?? rawTarget;
}

function findOwningSymbol(
  entry: FileStructuralEntry,
  line: number | undefined,
): ExtractedSymbol | null {
  if (!line) {
    return null;
  }
  return (
    entry.symbols
      .filter((symbol) => symbol.start_line <= line && symbol.end_line >= line)
      .sort(
        (left, right) =>
          left.end_line - left.start_line - (right.end_line - right.start_line),
      )[0] ?? null
  );
}

function resolveCallTargets(
  index: StructuralIndex,
  source: FileStructuralEntry,
  rawTarget: string,
  includeTests: boolean,
): {
  matches: Array<{ entry: FileStructuralEntry; symbol: ExtractedSymbol }>;
  resolution: "local" | "import" | "global" | "unresolved";
} {
  const target = callTargetName(rawTarget);
  const local = source.symbols
    .filter((symbol) => symbol.name === target)
    .map((symbol) => ({ entry: source, symbol }));
  if (local.length > 0) {
    return { matches: local, resolution: "local" };
  }

  const importedPaths = new Set(
    source.imports
      .filter(
        (item) =>
          item.resolved_path &&
          (!item.symbols || item.symbols.length === 0 || item.symbols.includes(target)),
      )
      .map((item) => item.resolved_path!),
  );
  const imported = findFilesBySymbolName(index, target, includeTests).filter((match) =>
    importedPaths.has(match.entry.relative_path),
  );
  if (imported.length > 0) {
    return { matches: imported, resolution: "import" };
  }

  const global = findFilesBySymbolName(index, target, includeTests);
  return {
    matches: global,
    resolution: global.length > 0 ? "global" : "unresolved",
  };
}

function resolveTraceTarget(
  cwd: string,
  index: StructuralIndex,
  target: string,
  includeTests = false,
): TraceResolvedTarget | null {
  const normalized = target.trim();
  if (!normalized) {
    return null;
  }

  const fileSelection = selectFileTarget(index, normalized, includeTests);
  if (fileSelection.entry && fileSelection.entry.relative_path === normalized) {
    return {
      node: buildFileNode(fileSelection.entry),
      candidates: [],
    };
  }
  if (
    (normalized.includes("/") || normalized.includes(".")) &&
    fileSelection.entry &&
    fileSelection.candidates.length <= 1
  ) {
    return {
      node: buildFileNode(fileSelection.entry),
      candidates: [],
      limitations: ["Path resolvido por match parcial de arquivo; refine o alvo se precisar precisão absoluta."],
    };
  }
  if ((normalized.includes("/") || normalized.includes(".")) && fileSelection.candidates.length > 1) {
    return {
      candidates: fileSelection.candidates,
      limitations: ["Múltiplos arquivos candidatos para o alvo informado."],
    };
  }

  const metadata = readWorkspaceMetadata(cwd);
  if (!metadata) {
    return null;
  }
  const db = openIndexDb(getIndexDbPath(metadata.root_path), { readonly: true });
  try {
    const hits = searchFtsInternal(db, normalized, 20);
    const exactHits = hits.filter((hit) => hit.name.toLowerCase() === normalized.toLowerCase());
    if (exactHits.length === 1) {
      const hit = exactHits[0]!;
      const entry = index.files.find((file) => file.relative_path === hit.relative_path);
      const symbol = entry?.symbols.find((item) => item.name === hit.name);
      if (entry && symbol) {
        return { node: buildSymbolNode(entry, symbol), candidates: [] };
      }
    }
    if (exactHits.length > 1) {
      return {
        candidates: exactHits.slice(0, 10).map((hit) => ({
          name: hit.name,
          path: hit.relative_path,
          kind: hit.kind,
          reason: "exact_symbol_match",
        })),
        limitations: ["Múltiplos símbolos equivalentes encontrados para o alvo."],
      };
    }
    if (hits.length === 1) {
      const hit = hits[0]!;
      const entry = index.files.find((file) => file.relative_path === hit.relative_path);
      const symbol = entry?.symbols.find((item) => item.name === hit.name);
      if (entry && symbol) {
        return {
          node: buildSymbolNode(entry, symbol),
          candidates: [],
          limitations: ["Alvo resolvido por hit FTS único, sem correspondência exata por nome."],
        };
      }
    }
    if (hits.length > 1) {
      return {
        candidates: hits.slice(0, 10).map((hit) => ({
          name: hit.name,
          path: hit.relative_path,
          kind: hit.kind,
          reason: "fts_candidate",
        })),
        limitations: ["Múltiplos candidatos FTS encontrados para o alvo."],
      };
    }
  } finally {
    closeIndexDb(db);
  }

  return null;
}

function buildTraceAdjacency(
  index: StructuralIndex,
  includeTests: boolean,
): Map<string, TraceEdgeStep[]> {
  const adjacency = new Map<string, TraceEdgeStep[]>();
  const addEdge = (edge: TraceEdgeStep): void => {
    const current = adjacency.get(edge.from.id) ?? [];
    current.push(edge);
    adjacency.set(edge.from.id, current);
  };

  const fileNodes = new Map<string, TraceNode>();

  for (const entry of index.files) {
    if (!includeTests && fileMatchesTests(entry.relative_path)) {
      continue;
    }
    const fileNode = buildFileNode(entry);
    fileNodes.set(entry.relative_path, fileNode);
    for (const symbol of entry.symbols) {
      const symbolNode = buildSymbolNode(entry, symbol);
      addEdge({ relation: "declares", from: fileNode, to: symbolNode, line: symbol.start_line });
      addEdge({ relation: "defined_in", from: symbolNode, to: fileNode, line: symbol.start_line });
    }
  }

  for (const entry of index.files) {
    if (!includeTests && fileMatchesTests(entry.relative_path)) {
      continue;
    }
    const fileNode = fileNodes.get(entry.relative_path);
    if (!fileNode) {
      continue;
    }

    for (const imported of entry.imports) {
      if (!imported.resolved_path) {
        continue;
      }
      const targetFile = fileNodes.get(imported.resolved_path);
      if (!targetFile) {
        continue;
      }
      addEdge({ relation: "imports", from: fileNode, to: targetFile });
      addEdge({ relation: "imported_by", from: targetFile, to: fileNode });
    }

    for (const edge of entry.edges) {
      if (edge.kind === "calls") {
        const resolved = resolveCallTargets(index, entry, edge.to, includeTests);
        const caller = edge.from_symbol
          ? entry.symbols.find((symbol) => symbol.name === edge.from_symbol) ?? null
          : findOwningSymbol(entry, edge.line);
        const callerNode = caller ? buildSymbolNode(entry, caller) : fileNode;
        for (const match of resolved.matches) {
          const targetNode = buildSymbolNode(match.entry, match.symbol);
          const uncertain =
            resolved.resolution === "global"
              ? "Alvo resolvido globalmente por nome; não há import compatível comprovando o vínculo."
              : resolved.matches.length > 1
                ? "Mais de um alvo compatível permanece após resolução por import."
                : caller
                  ? undefined
                  : "Símbolo chamador não identificado; chamada atribuída ao arquivo.";
          addEdge({
            relation: "calls",
            from: callerNode,
            to: targetNode,
            line: edge.line,
            uncertain,
          });
          addEdge({
            relation: "called_by",
            from: targetNode,
            to: callerNode,
            line: edge.line,
            uncertain,
          });
        }
      }

      if (edge.kind === "extends" || edge.kind === "implements") {
        const originSymbol = entry.symbols.find((symbol) => symbol.name === edge.from_symbol);
        if (!originSymbol) {
          continue;
        }
        const originNode = buildSymbolNode(entry, originSymbol);
        const targetMatches = findFilesBySymbolName(index, edge.to, includeTests);
        for (const match of targetMatches) {
          const targetNode = buildSymbolNode(match.entry, match.symbol);
          const uncertain =
            targetMatches.length > 1
              ? "Múltiplos símbolos com o mesmo nome podem representar este alvo."
              : undefined;
          addEdge({
            relation: edge.kind,
            from: originNode,
            to: targetNode,
            line: edge.line,
            uncertain,
          });
          addEdge({
            relation: `${edge.kind}_by`,
            from: targetNode,
            to: originNode,
            line: edge.line,
            uncertain,
          });
        }
      }
    }
  }

  return adjacency;
}

function bfsTracePath(
  adjacency: Map<string, TraceEdgeStep[]>,
  fromNode: TraceNode,
  targetNode: TraceNode | null,
  maxHops: number,
): TraceEdgeStep[] | null {
  const queue: Array<{ node: TraceNode; path: TraceEdgeStep[] }> = [{ node: fromNode, path: [] }];
  const visited = new Set<string>([fromNode.id]);

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (targetNode && current.node.id === targetNode.id) {
      return current.path;
    }
    if (current.path.length >= maxHops) {
      continue;
    }
    const nextEdges = adjacency.get(current.node.id) ?? [];
    for (const edge of nextEdges) {
      if (visited.has(edge.to.id)) {
        continue;
      }
      const nextPath = [...current.path, edge];
      if (!targetNode) {
        return nextPath;
      }
      visited.add(edge.to.id);
      queue.push({ node: edge.to, path: nextPath });
    }
  }

  return null;
}

function toTracePathPayload(path: TraceEdgeStep[]): TracePathPayload {
  return {
    hops: path.map((edge) => ({
      relation: edge.relation,
      name: edge.to.name,
      path: edge.to.path,
      node_type: edge.to.node_type,
      symbol_kind: edge.to.symbol_kind,
      line: edge.line ?? edge.to.line,
    })),
    files: uniqueByKey(
      path.flatMap((edge) => [edge.from.path, edge.to.path]),
      (item) => item,
    ),
    symbols: uniqueByKey(
      path.flatMap((edge) =>
        [edge.from, edge.to]
          .filter((node) => node.node_type === "symbol")
          .map((node) => `${node.name}@${node.path}`),
      ),
      (item) => item,
    ),
  };
}

function collectTraceUncertainty(
  path: TraceEdgeStep[],
  limitations: string[] = [],
): TraceUncertaintyPoint[] {
  return [
    ...path
      .filter((edge) => Boolean(edge.uncertain))
      .map((edge) => ({
        reason: edge.uncertain!,
        path: edge.to.path,
        symbol: edge.to.node_type === "symbol" ? edge.to.name : undefined,
        relation: edge.relation,
      })),
    ...limitations.map((reason) => ({ reason })),
  ];
}

function buildTraceStub(
  cwd: string,
  semanticStub: SemanticStubEnvelope,
  args?: TraceArgs,
): ToolStubPayload {
  const from = args?.from?.trim() ?? "";
  if (!from) {
    return {
      paths: [],
      files: [],
      symbols: [],
      uncertainty_points: [],
      ...stubResponse("falha", "Input inválido para a tool"),
    };
  }

  if (semanticStub.state === "falha" || !semanticStub.structuralIndex) {
    return {
      paths: [],
      files: [],
      symbols: [],
      uncertainty_points: [],
      ...stubResponse(semanticStub.state, semanticStub.message, {
        limitations: semanticStub.limitations,
        staleness_hint: semanticStub.staleness_hint,
      }),
    };
  }

  const index = semanticStub.structuralIndex;
  const maxHops = Math.max(1, Math.min(args?.max_hops ?? 4, 6));
  const direction = args?.direction ?? "forward";
  const fromResolved = resolveTraceTarget(cwd, index, from);
  if (!fromResolved) {
    return {
      paths: [],
      files: [],
      symbols: [],
      uncertainty_points: [],
      ...stubResponse("falha", "E_INSUFFICIENT_EVIDENCE: Origem não resolvida no índice atual."),
    };
  }
  if (!fromResolved.node && fromResolved.candidates.length > 0) {
    return {
      paths: [],
      files: [],
      symbols: [],
      uncertainty_points: collectTraceUncertainty([], fromResolved.limitations),
      candidates: fromResolved.candidates,
      ...stubResponse("ambigua", "Múltiplos alvos encontrados para `from`; refine o target.", {
        limitations: fromResolved.limitations,
      }),
    };
  }

  const toResolved = args?.to ? resolveTraceTarget(cwd, index, args.to) : null;
  if (args?.to && !toResolved) {
    return {
      paths: [],
      files: [],
      symbols: [],
      uncertainty_points: [],
      ...stubResponse("falha", "E_INSUFFICIENT_EVIDENCE: Destino não resolvido no índice atual."),
    };
  }
  if (toResolved && !toResolved.node && toResolved.candidates.length > 0) {
    return {
      paths: [],
      files: [],
      symbols: [],
      uncertainty_points: collectTraceUncertainty([], toResolved.limitations),
      candidates: toResolved.candidates,
      ...stubResponse("ambigua", "Múltiplos alvos encontrados para `to`; refine o destino.", {
        limitations: toResolved.limitations,
      }),
    };
  }

  const adjacency = buildTraceAdjacency(index, false);
  const fromNode = fromResolved.node!;
  const targetNode = toResolved?.node ?? null;
  let path =
    direction === "backward" && targetNode
      ? bfsTracePath(adjacency, targetNode, fromNode, maxHops)
      : bfsTracePath(adjacency, fromNode, targetNode, maxHops);

  if (!path && direction === "both" && targetNode) {
    path = bfsTracePath(adjacency, targetNode, fromNode, maxHops);
  }

  if (!path || path.length === 0) {
    return {
      paths: [],
      files: [],
      symbols: [],
      uncertainty_points: collectTraceUncertainty([], [
        ...(fromResolved.limitations ?? []),
        ...(toResolved?.limitations ?? []),
      ]),
      ...stubResponse(
        targetNode ? "parcial" : "falha",
        targetNode
          ? "Nenhum caminho provável encontrado dentro do budget/hops atual."
          : "E_INSUFFICIENT_EVIDENCE: Não foi possível derivar um caminho inicial a partir da origem.",
        {
          limitations: [
            ...(fromResolved.limitations ?? []),
            ...(toResolved?.limitations ?? []),
            "Trace v1 depende do grafo estrutural atual; chamadas dinâmicas e wiring implícito podem ficar fora.",
          ],
          staleness_hint: semanticStub.staleness_hint,
        },
      ),
    };
  }

  const payloadPath = toTracePathPayload(path);
  const pathFiles = payloadPath.files;
  const partialCoverage = pathFiles.some((relativePath) => {
    const language = index.files.find((entry) => entry.relative_path === relativePath)?.language;
    return language ? index.coverage_by_language[language]?.coverage_level === "partial" : false;
  });
  const uncertaintyPoints = collectTraceUncertainty(path, [
    ...(fromResolved.limitations ?? []),
    ...(toResolved?.limitations ?? []),
  ]);
  const state =
    semanticStub.state === "stale"
      ? "stale"
      : partialCoverage || uncertaintyPoints.length > 0
        ? "parcial"
        : "sucesso";

  return {
    paths: [payloadPath],
    files: payloadPath.files,
    symbols: payloadPath.symbols,
    uncertainty_points: uncertaintyPoints,
    ...stubResponse(state, "Trace provável derivado do índice estrutural.", {
      limitations: [
        ...(partialCoverage
          ? ["Cobertura parcial em pelo menos uma das linguagens do caminho; o trace pode estar incompleto."]
          : []),
        ...(uncertaintyPoints.length > 0
          ? ["Trace v1 usa inferência estrutural; revise `uncertainty_points` antes de decisões críticas."]
          : []),
      ],
      staleness_hint: semanticStub.staleness_hint,
    }),
  };
}

function mapImpactDirectionToTrace(direction: ImpactArgs["direction"]): "forward" | "backward" | "both" {
  switch (direction) {
    case "dependencies":
      return "forward";
    case "dependents":
      return "backward";
    case "both":
    default:
      return "both";
  }
}

function impactRefFromNode(node: TraceNode, depth: number, relation?: string): ImpactRef {
  return {
    name: node.name,
    path: node.path,
    node_type: node.node_type,
    symbol_kind: node.symbol_kind,
    depth,
    relation,
  };
}

function summarizeImpactRisk(
  directCount: number,
  indirectCount: number,
  uncertaintyCount: number,
  testCount: number,
): string {
  const magnitude =
    directCount + indirectCount >= 8 ? "alto" : directCount + indirectCount >= 4 ? "medio" : "baixo";
  return `Blast radius ${magnitude}: ${directCount} afetado(s) direto(s), ${indirectCount} indireto(s), ${testCount} teste(s) relacionado(s) e ${uncertaintyCount} ponto(s) de incerteza.`;
}

function buildImpactStub(
  cwd: string,
  semanticStub: SemanticStubEnvelope,
  args?: ImpactArgs,
): ToolStubPayload {
  const target = args?.target?.trim() ?? "";
  if (!target) {
    return {
      direct_affected: [],
      indirect_affected: [],
      files: [],
      tests: [],
      risk_summary: "",
      ...stubResponse("falha", "Input inválido para a tool"),
    };
  }

  if (semanticStub.state === "falha" || !semanticStub.structuralIndex) {
    return {
      direct_affected: [],
      indirect_affected: [],
      files: [],
      tests: [],
      risk_summary: "",
      ...stubResponse(semanticStub.state, semanticStub.message, {
        limitations: semanticStub.limitations,
        staleness_hint: semanticStub.staleness_hint,
      }),
    };
  }

  const index = semanticStub.structuralIndex;
  const includeTests = args?.include_tests ?? false;
  const depthLimit = Math.max(1, Math.min(args?.depth ?? 3, 8));
  const direction = args?.direction ?? "both";
  const traceDirection = mapImpactDirectionToTrace(direction);
  const resolved = resolveTraceTarget(cwd, index, target, includeTests);

  if (!resolved) {
    return {
      direct_affected: [],
      indirect_affected: [],
      files: [],
      tests: [],
      risk_summary: "",
      ...stubResponse("falha", "E_INSUFFICIENT_EVIDENCE: Alvo não resolvido no índice atual."),
    };
  }

  if (!resolved.node && resolved.candidates.length > 0) {
    return {
      direct_affected: [],
      indirect_affected: [],
      files: [],
      tests: [],
      risk_summary: "",
      candidates: resolved.candidates,
      ...stubResponse("ambigua", "Múltiplos alvos encontrados para impact; refine o target.", {
        limitations: resolved.limitations,
      }),
    };
  }

  const adjacency = buildTraceAdjacency(index, includeTests);
  const startNode = resolved.node!;
  const queue: Array<{ node: TraceNode; depth: number; via?: string }> = [{ node: startNode, depth: 0 }];
  const visited = new Set<string>([startNode.id]);
  const directAffected: ImpactRef[] = [];
  const indirectAffected: ImpactRef[] = [];
  const uncertaintyPoints: TraceUncertaintyPoint[] = [...collectTraceUncertainty([], resolved.limitations)];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.depth >= depthLimit) {
      continue;
    }
    const neighbors = adjacency.get(current.node.id) ?? [];
    for (const edge of neighbors) {
      const relationAllowed =
        traceDirection === "both" ||
        (traceDirection === "forward" && !edge.relation.endsWith("_by") && edge.relation !== "called_by" && edge.relation !== "imported_by") ||
        (traceDirection === "backward" && (edge.relation.endsWith("_by") || edge.relation === "called_by" || edge.relation === "imported_by"));
      if (!relationAllowed) {
        continue;
      }
      if (visited.has(edge.to.id)) {
        continue;
      }
      visited.add(edge.to.id);
      const nextDepth = current.depth + 1;
      const ref = impactRefFromNode(edge.to, nextDepth, edge.relation);
      if (nextDepth === 1) {
        directAffected.push(ref);
      } else {
        indirectAffected.push(ref);
      }
      if (edge.uncertain) {
        uncertaintyPoints.push({
          reason: edge.uncertain,
          path: edge.to.path,
          symbol: edge.to.node_type === "symbol" ? edge.to.name : undefined,
          relation: edge.relation,
          detail: edge.uncertain,
        });
      }
      queue.push({ node: edge.to, depth: nextDepth, via: edge.relation });
    }
  }

  const directUnique = uniqueByKey(directAffected, (item) => `${item.node_type}:${item.path}:${item.name}`).slice(0, 50);
  const indirectUnique = uniqueByKey(indirectAffected, (item) => `${item.node_type}:${item.path}:${item.name}`).slice(0, 100);
  const allFiles = uniqueByKey(
    [startNode.path, ...directUnique.map((item) => item.path), ...indirectUnique.map((item) => item.path)],
    (item) => item,
  );
  const tests = allFiles.filter((path) => fileMatchesTests(path));
  const partialCoverage = allFiles.some((relativePath) => {
    const language = index.files.find((entry) => entry.relative_path === relativePath)?.language;
    return language ? index.coverage_by_language[language]?.coverage_level === "partial" : false;
  });
  const riskSummary = summarizeImpactRisk(
    directUnique.length,
    indirectUnique.length,
    uncertaintyPoints.length,
    tests.length,
  );
  const state =
    semanticStub.state === "stale"
      ? "stale"
      : partialCoverage || uncertaintyPoints.length > 0
        ? "parcial"
        : "sucesso";

  return {
    direct_affected: args?.summary_only ? [] : directUnique,
    indirect_affected: args?.summary_only ? [] : indirectUnique,
    files: allFiles,
    tests,
    risk_summary: riskSummary,
    ...stubResponse(state, "Blast radius provável derivado do índice estrutural.", {
      limitations: [
        ...(partialCoverage
          ? ["Cobertura parcial em pelo menos uma das linguagens afetadas; o impacto pode estar incompleto."]
          : []),
        ...(uncertaintyPoints.length > 0
          ? ["Impact v1 depende do mesmo grafo estrutural de trace; revise os pontos de incerteza antes de mudanças críticas."]
          : []),
      ],
      staleness_hint: semanticStub.staleness_hint,
    }),
  };
}

function normalizeRelativePath(pathValue: string): string {
  return pathValue.split("\\").join("/");
}

function summarizeDiffImpactRisk(
  changedFileCount: number,
  changedSymbolCount: number,
  affectedAreaCount: number,
  affectedTestCount: number,
  unresolvedCount: number,
): string {
  if (changedFileCount === 0) {
    return "Nenhuma mudança local detectada no escopo solicitado.";
  }

  const magnitude =
    changedFileCount + affectedTestCount >= 10
      ? "alto"
      : changedFileCount + affectedTestCount >= 4
        ? "medio"
        : "baixo";
  return `Diff impact ${magnitude}: ${changedFileCount} arquivo(s) alterado(s), ${changedSymbolCount} símbolo(s) alterado(s), ${affectedAreaCount} área(s) afetada(s), ${affectedTestCount} teste(s) afetado(s) e ${unresolvedCount} arquivo(s) fora do grafo atual.`;
}

function resolveGitRoot(cwd: string): { root: string } | { error: string } {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf-8",
  });

  if (result.status !== 0) {
    return { error: "E_GIT_INVALID: Repositório Git inválido ou inacessível para diff_impact." };
  }

  const root = result.stdout.trim();
  if (!root) {
    return { error: "E_GIT_INVALID: Repositório Git inválido ou inacessível para diff_impact." };
  }

  return { root };
}

function collectGitPaths(cwd: string, args: string[]): { paths: string[] } | { error: string } {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf-8",
  });

  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    return {
      error: detail
        ? `E_GIT_DIFF_UNAVAILABLE: ${detail}`
        : "E_GIT_DIFF_UNAVAILABLE: Não foi possível ler o diff Git atual.",
    };
  }

  const paths = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return { paths };
}

function toWorkspaceRelativePath(cwd: string, gitRoot: string, gitPath: string): string | null {
  const workspaceRoot = realpathSync.native(cwd);
  const normalizedGitRoot = realpathSync.native(gitRoot);
  const absolutePath = resolve(normalizedGitRoot, gitPath);
  const workspaceRelative = normalizeRelativePath(relative(workspaceRoot, absolutePath));
  if (!workspaceRelative || workspaceRelative.startsWith("../")) {
    return null;
  }
  return workspaceRelative;
}

function collectGitText(cwd: string, args: string[]): { text: string } | { error: string } {
  const result = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    return {
      error: detail
        ? `E_GIT_DIFF_UNAVAILABLE: ${detail}`
        : "E_GIT_DIFF_UNAVAILABLE: Não foi possível ler o diff Git atual.",
    };
  }
  return { text: result.stdout };
}

function parseChangedHunks(cwd: string, gitRoot: string, diffText: string): DiffChangedHunk[] {
  const hunks: DiffChangedHunk[] = [];
  let currentPath: string | null = null;
  let previousPath: string | null = null;
  for (const line of diffText.split("\n")) {
    if (line.startsWith("--- a/")) {
      previousPath = toWorkspaceRelativePath(cwd, gitRoot, line.slice(6));
      continue;
    }
    if (line.startsWith("+++ b/")) {
      currentPath = toWorkspaceRelativePath(cwd, gitRoot, line.slice(6));
      continue;
    }
    if (line === "+++ /dev/null") {
      currentPath = previousPath;
      continue;
    }
    if (!currentPath || !line.startsWith("@@")) {
      continue;
    }
    const match = /-(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))?/.exec(line);
    if (!match) {
      continue;
    }
    const addedCount = Number(match[4] ?? "1");
    const usesRemovedRange = addedCount === 0;
    hunks.push({
      path: currentPath,
      start_line: Number(usesRemovedRange ? match[1] : match[3]),
      line_count: Math.max(1, Number(usesRemovedRange ? (match[2] ?? "1") : addedCount)),
    });
  }
  return hunks;
}

function readChangedFilesFromGit(
  cwd: string,
  args?: DiffImpactArgs,
): {
  changedFiles: string[];
  changedHunks: DiffChangedHunk[];
  scope: NonNullable<DiffImpactArgs["scope"]>;
} | { error: string } {
  const scope = args?.scope ?? "all";
  if (scope === "compare" && !args?.base_ref?.trim()) {
    return { error: "E_BASE_REF_REQUIRED: `base_ref` é obrigatório quando `scope=compare`." };
  }

  const gitRootResult = resolveGitRoot(cwd);
  if ("error" in gitRootResult) {
    return gitRootResult;
  }

  const gitRoot = gitRootResult.root;
  const collected = new Set<string>();
  const segments: string[][] = [];
  const diffSegments: string[][] = [];

  if (scope === "unstaged") {
    segments.push(["diff", "--name-only"]);
    segments.push(["ls-files", "--others", "--exclude-standard"]);
    diffSegments.push(["diff", "--unified=0", "--no-color"]);
  } else if (scope === "staged") {
    segments.push(["diff", "--cached", "--name-only"]);
    diffSegments.push(["diff", "--cached", "--unified=0", "--no-color"]);
  } else if (scope === "compare") {
    segments.push(["diff", "--name-only", `${args!.base_ref!.trim()}...HEAD`]);
    diffSegments.push(["diff", "--unified=0", "--no-color", `${args!.base_ref!.trim()}...HEAD`]);
  } else {
    segments.push(["diff", "--name-only"]);
    segments.push(["diff", "--cached", "--name-only"]);
    segments.push(["ls-files", "--others", "--exclude-standard"]);
    diffSegments.push(["diff", "--unified=0", "--no-color"]);
    diffSegments.push(["diff", "--cached", "--unified=0", "--no-color"]);
  }

  for (const segment of segments) {
    const output = collectGitPaths(gitRoot, segment);
    if ("error" in output) {
      return output;
    }
    for (const gitPath of output.paths) {
      const workspaceRelative = toWorkspaceRelativePath(cwd, gitRoot, gitPath);
      if (workspaceRelative) {
        collected.add(workspaceRelative);
      }
    }
  }

  const changedHunks: DiffChangedHunk[] = [];
  for (const segment of diffSegments) {
    const output = collectGitText(gitRoot, segment);
    if ("error" in output) {
      return output;
    }
    changedHunks.push(...parseChangedHunks(cwd, gitRoot, output.text));
  }

  return {
    changedFiles: Array.from(collected).sort((left, right) => left.localeCompare(right)),
    changedHunks,
    scope,
  };
}

function extractChangedSymbols(
  index: StructuralIndex,
  changedFiles: string[],
  changedHunks: DiffChangedHunk[],
): DiffImpactSymbol[] {
  const byPath = new Set(changedFiles);
  const hunksByPath = new Map<string, DiffChangedHunk[]>();
  for (const hunk of changedHunks) {
    const current = hunksByPath.get(hunk.path) ?? [];
    current.push(hunk);
    hunksByPath.set(hunk.path, current);
  }
  const symbols: DiffImpactSymbol[] = [];

  for (const file of index.files) {
    if (!byPath.has(file.relative_path)) {
      continue;
    }
    const hunks = hunksByPath.get(file.relative_path) ?? [];
    for (const symbol of file.symbols) {
      if (
        hunks.length > 0 &&
        !hunks.some((hunk) => {
          const hunkEnd = hunk.start_line + hunk.line_count - 1;
          return symbol.start_line <= hunkEnd && symbol.end_line >= hunk.start_line;
        })
      ) {
        continue;
      }
      symbols.push({
        name: symbol.name,
        path: file.relative_path,
        kind: symbol.kind,
      });
    }
  }

  return uniqueByKey(symbols, (item) => `${item.path}:${item.kind ?? ""}:${item.name}`);
}

function buildAffectedAreas(paths: string[]): string[] {
  const areas = paths.map((pathValue) => {
    const dir = normalizeRelativePath(dirname(pathValue));
    return dir === "." ? "." : dir;
  });
  return uniqueByKey(areas, (item) => item).sort((left, right) => left.localeCompare(right));
}

/**
 * Estimador de tokens code-aware (sem dependência de tokenizer). `chars/4`
 * subestima código (muitos tokens curtos + pontuação), arriscando estourar o
 * budget real; contar tokens lexicais (identificadores/números/pontuação) é mais
 * conservador. Mantém o piso `chars/4` para subdividir identificadores longos
 * em prosa densa. (Um tokenizer real — tiktoken / token-count Anthropic — segue
 * como opção futura, ao custo de dependência/rede.)
 */
function approximateTokenCount(text: string): number {
  const lexical = text.match(/[A-Za-z0-9_$]+|[^\sA-Za-z0-9_$]/g)?.length ?? 0;
  return Math.max(1, lexical, Math.ceil(text.length / 4));
}

/**
 * Resumo de segmento que **preserva o código**. As linhas de scaffolding em
 * pt-br (`Fonte:`/`Objetivo local:`/`Resumo:`/…) vêm primeiro e os blocos de
 * código (`Snippet …`) por último; truncar as primeiras N linhas — o bug
 * anterior — descartava justamente o código e deixava o segmento "resumido" sem
 * código nenhum. Aqui mantemos a 1ª linha (`Fonte:`, para rastreio) + o código,
 * truncando pelo fim até caber no budget.
 */
function summarizeSegmentText(text: string, budget: number): string {
  const lines = text.split("\n");
  if (lines.length === 0) {
    return text;
  }
  const snippetStart = lines.findIndex((line) => line.startsWith("Snippet "));
  const head = [lines[0]!];
  const candidate =
    snippetStart >= 0 ? [...head, ...lines.slice(snippetStart)] : lines.slice(0, 4);

  let kept = candidate;
  while (kept.length > 1 && approximateTokenCount(`\n\n${kept.join("\n")}`) > budget) {
    kept = kept.slice(0, -1);
  }
  return kept.join("\n");
}

function getPackStyleConfig(style: NonNullable<PackContextArgs["style"]>): {
  depth: number;
  budget: number;
  snippetLimit: number;
} {
  switch (style) {
    case "brief":
      return { depth: 1, budget: 4, snippetLimit: 1 };
    case "deep":
      return { depth: 4, budget: 10, snippetLimit: 3 };
    case "balanced":
    default:
      return { depth: 2, budget: 6, snippetLimit: 2 };
  }
}

function getPackedHandlesDir(cwd: string): string {
  return join(cwd, ".cortex", "packed-handles");
}

function getPackedHandlePath(cwd: string, handle: string): string {
  return join(getPackedHandlesDir(cwd), handle);
}

function isValidRetrieveHandle(handle: string): boolean {
  return /^rh_[a-f0-9]{16}$/.test(handle);
}

function compareReversibility(
  left: ReadStoredPackHandleResult["reversibility"],
  right: ReadStoredPackHandleResult["reversibility"],
): ReadStoredPackHandleResult["reversibility"] {
  const order = { full: 0, partial: 1, none: 2 } as const;
  return order[left] >= order[right] ? left : right;
}

function registerPackedHandleInIndex(cwd: string, handle: string, createdAt: string): void {
  try {
    const db = openIndexDb(getIndexDbPath(cwd));
    try {
      db.prepare("INSERT OR REPLACE INTO packed_handles (handle, created_at) VALUES (?, ?)").run(
        handle,
        createdAt,
      );
    } finally {
      closeIndexDb(db);
    }
  } catch {
    // best effort; filesystem persistence remains source of truth for MVP
  }
}

function readStoredPackHandle(cwd: string, handle: string): ReadStoredPackHandleResult {
  if (!isValidRetrieveHandle(handle)) {
    return {
      found: false,
      segments: [],
      limitations: ["Retrieve handle inválido."],
      reversibility: "none",
    };
  }
  const handleDir = getPackedHandlePath(cwd, handle);
  const manifestPath = join(handleDir, "manifest.json");
  if (!existsSync(manifestPath)) {
    return {
      found: false,
      segments: [],
      limitations: [],
      reversibility: "none",
    };
  }

  let manifest: StoredPackHandle;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as StoredPackHandle;
  } catch {
    return {
      found: true,
      segments: [],
      limitations: [`Retrieve handle corrompido: ${handle}.`],
      reversibility: "none",
    };
  }
  if (!Array.isArray(manifest.segments)) {
    return {
      found: true,
      segments: [],
      limitations: [`Retrieve handle corrompido: ${handle}.`],
      reversibility: "none",
    };
  }

  const limitations: string[] = [];
  const segments: PackSegment[] = [];
  let reversibility: ReadStoredPackHandleResult["reversibility"] = "full";

  for (const segment of manifest.segments) {
    if (
      !segment ||
      typeof segment.ref !== "string" ||
      !Array.isArray(segment.originRefs) ||
      typeof segment.body_file !== "string"
    ) {
      limitations.push(`Segmento inválido no retrieve_handle ${handle}.`);
      reversibility = compareReversibility(reversibility, "partial");
      continue;
    }
    const bodyPath = join(handleDir, segment.body_file);
    if (!isWithinPath(handleDir, bodyPath) || !isWithinPath(cwd, bodyPath)) {
      limitations.push(`Segmento fora do workspace rejeitado para retrieve_handle ${handle}.`);
      reversibility = compareReversibility(reversibility, "partial");
      continue;
    }
    if (!existsSync(bodyPath)) {
      limitations.push(`Segmento ausente para retrieve_handle ${handle}: ${segment.ref}.`);
      reversibility = compareReversibility(reversibility, "partial");
      continue;
    }

    try {
      const text = readFileSync(bodyPath, "utf-8");
      segments.push({
        ref: segment.ref,
        text,
        originRefs: segment.originRefs,
      });
    } catch {
      limitations.push(`Falha ao ler segmento persistido de ${handle}: ${segment.ref}.`);
      reversibility = compareReversibility(reversibility, "partial");
    }
  }

  if (segments.length === 0) {
    reversibility = "none";
  }

  return {
    found: true,
    segments,
    limitations,
    reversibility,
  };
}

function buildRetrieveStub(cwd: string, args?: RetrieveArgs): ToolStubPayload {
  const handle = args?.handle?.trim() ?? "";
  if (!isValidRetrieveHandle(handle)) {
    return {
      handle,
      content: "",
      origin_refs: [],
      reversibility: "none",
      ...stubResponse("falha", "E_RETRIEVE_INVALID: Handle inválido."),
    };
  }

  const stored = readStoredPackHandle(cwd, handle);
  if (!stored.found) {
    return {
      handle,
      content: "",
      origin_refs: [],
      reversibility: "none",
      ...stubResponse("falha", "E_RETRIEVE_NOT_FOUND: Handle não encontrado neste workspace."),
    };
  }

  const originRefs = uniqueOriginRefs(stored.segments.flatMap((segment) => segment.originRefs));
  const content = stored.segments.map((segment) => segment.text).join("\n\n");
  if (!content) {
    return {
      handle,
      content: "",
      origin_refs: originRefs,
      reversibility: "none",
      ...stubResponse("falha", "E_RETRIEVE_UNAVAILABLE: Conteúdo original indisponível.", {
        limitations: stored.limitations,
      }),
    };
  }

  return {
    handle,
    content,
    origin_refs: originRefs,
    segment_count: stored.segments.length,
    reversibility: stored.reversibility,
    ...stubResponse(
      stored.reversibility === "full" ? "sucesso" : "parcial",
      stored.reversibility === "full"
        ? "Conteúdo original recuperado."
        : "Conteúdo recuperado parcialmente.",
      { limitations: stored.limitations },
    ),
  };
}

function writeStoredPackHandle(
  cwd: string,
  payload: {
    handle: string;
    created_at: string;
    goal: string;
    style: NonNullable<PackContextArgs["style"]>;
    token_budget: number;
    manifest_hash?: string | null;
    schema_version?: string | null;
    segments: PackSegment[];
  },
): ReadStoredPackHandleResult["reversibility"] {
  const handleDir = getPackedHandlePath(cwd, payload.handle);
  rmSync(handleDir, { recursive: true, force: true });
  mkdirSync(handleDir, { recursive: true });

  const manifest: StoredPackHandle = {
    handle: payload.handle,
    created_at: payload.created_at,
    goal: payload.goal,
    style: payload.style,
    token_budget: payload.token_budget,
    manifest_hash: payload.manifest_hash,
    schema_version: payload.schema_version,
    segments: [],
  };

  let reversibility: ReadStoredPackHandleResult["reversibility"] = "full";

  for (const [index, segment] of payload.segments.entries()) {
    const bodyFile = `segment-${String(index + 1).padStart(3, "0")}.txt`;
    const bodyPath = join(handleDir, bodyFile);
    try {
      writeFileSync(bodyPath, segment.text, "utf-8");
      manifest.segments.push({
        ref: segment.ref,
        originRefs: segment.originRefs,
        body_file: bodyFile,
      });
    } catch {
      reversibility = compareReversibility(reversibility, "partial");
    }
  }

  try {
    writeFileSync(join(handleDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf-8");
  } catch {
    return "none";
  }

  registerPackedHandleInIndex(cwd, payload.handle, payload.created_at);
  if (manifest.segments.length === 0) {
    return "none";
  }
  return reversibility;
}

function uniqueOriginRefs(refs: PackOriginRef[]): PackOriginRef[] {
  return uniqueByKey(
    refs,
    (item) =>
      `${item.ref}:${item.path}:${item.start_line ?? ""}:${item.end_line ?? ""}:${item.symbol ?? ""}`,
  );
}

function readSnippetContent(cwd: string, ref: ExploreSnippetRef): string | null {
  try {
    const absolutePath = join(cwd, ref.path);
    const lines = readFileSync(absolutePath, "utf-8").split("\n");
    const start = Math.max(0, ref.start_line - 1);
    const end = Math.min(lines.length, ref.end_line);
    return lines.slice(start, end).join("\n").trim() || null;
  } catch {
    return null;
  }
}

function sourceLooksLikeIndexedFile(index: StructuralIndex, source: string): boolean {
  return index.files.some((entry) => entry.relative_path === source);
}

function buildPackSegmentsFromSource(
  cwd: string,
  semanticStub: SemanticStubEnvelope,
  source: string,
  goal: string,
  style: NonNullable<PackContextArgs["style"]>,
): {
  segments: PackSegment[];
  limitations: string[];
  reversibility: ReadStoredPackHandleResult["reversibility"];
} {
  const trimmed = source.trim();
  if (!trimmed) {
    return { segments: [], limitations: [], reversibility: "full" };
  }

  if (trimmed.startsWith("rh_")) {
    const stored = readStoredPackHandle(cwd, trimmed);
    if (!stored.found) {
      return {
        segments: [],
        limitations: [`Retrieve handle não encontrado: ${trimmed}.`],
        reversibility: "none",
      };
    }
    return {
      segments: stored.segments,
      limitations: stored.limitations,
      reversibility: stored.reversibility,
    };
  }

  if (!semanticStub.structuralIndex) {
    return {
      segments: [],
      limitations: ["Índice estrutural indisponível para empacotar fontes locais."],
      reversibility: "none",
    };
  }

  const config = getPackStyleConfig(style);
  const mode = sourceLooksLikeIndexedFile(semanticStub.structuralIndex, trimmed) ? "file" : "symbol";
  const payload = buildExploreStub(cwd, semanticStub, {
    target: trimmed,
    mode,
    depth: config.depth,
    budget: config.budget,
    include_tests: style === "deep",
  });

  if (payload.state === "falha" || payload.state === "ambigua") {
    return {
      segments: [],
      limitations: [
        typeof payload.message === "string"
          ? payload.message
          : `Fonte não resolvida para pack_context: ${trimmed}.`,
      ],
      reversibility: "none",
    };
  }

  const centralSymbols = (payload.central_symbols as Array<{
    name: string;
    path: string;
    start_line: number;
    end_line: number;
  }> | undefined) ?? [];
  const relevantFiles = (payload.relevant_files as Array<{ path: string; reason?: string }> | undefined) ?? [];
  const callers = (payload.callers as Array<{ name: string; path: string }> | undefined) ?? [];
  const callees = (payload.callees as Array<{ name: string; path: string }> | undefined) ?? [];
  const snippets = ((payload.snippets as ExploreSnippetRef[] | undefined) ?? []).slice(0, config.snippetLimit);
  const originRefs = uniqueOriginRefs([
    ...centralSymbols.map((item) => ({
      ref: trimmed,
      path: item.path,
      start_line: item.start_line,
      end_line: item.end_line,
      symbol: item.name,
    })),
    ...snippets.map((item) => ({
      ref: trimmed,
      path: item.path,
      start_line: item.start_line,
      end_line: item.end_line,
      symbol: item.symbol,
    })),
  ]);
  const snippetBlocks = snippets
    .map((snippet) => {
      const content = readSnippetContent(cwd, snippet);
      if (!content) {
        return null;
      }
      return `Snippet ${snippet.path}:${snippet.start_line}-${snippet.end_line}\n${content}`;
    })
    .filter((item): item is string => item !== null);

  const lines = [
    `Fonte: ${trimmed}`,
    `Objetivo local: ${goal}`,
    `Resumo: ${String(payload.summary ?? "")}`,
    centralSymbols.length > 0
      ? `Símbolos centrais: ${centralSymbols.map((item) => item.name).join(", ")}`
      : null,
    relevantFiles.length > 0
      ? `Arquivos relevantes: ${relevantFiles.map((item) => item.path).join(", ")}`
      : null,
    callers.length > 0 ? `Chamadores: ${callers.map((item) => `${item.name}@${item.path}`).join(", ")}` : null,
    callees.length > 0 ? `Callees: ${callees.map((item) => `${item.name}@${item.path}`).join(", ")}` : null,
    ...snippetBlocks,
  ].filter((item): item is string => Boolean(item && item.trim().length > 0));

  return {
    segments: [
      {
        ref: trimmed,
        text: lines.join("\n"),
        originRefs,
      },
    ],
    limitations: ((payload.limitations as string[] | undefined) ?? []).slice(0, 4),
    reversibility: "full",
  };
}

function buildPackContextStub(
  cwd: string,
  semanticStub: SemanticStubEnvelope,
  args?: PackContextArgs,
): ToolStubPayload {
  const sources = uniqueByKey(
    ((args?.sources ?? []).map((item) => item.trim()).filter((item) => item.length > 0)),
    (item) => item,
  );
  const goal = args?.goal?.trim() ?? "";
  const tokenBudget = Math.max(1, Math.min(args?.token_budget ?? 0, 8000));
  const style = args?.style ?? "balanced";

  if (sources.length === 0 || !goal || !args?.token_budget) {
    return {
      packed_context: "",
      origin_refs: [],
      removed_or_summarized: [],
      reversibility: "none",
      token_estimate: 0,
      ...stubResponse("falha", "Input inválido para a tool"),
    };
  }

  if (semanticStub.state === "falha" && !sources.every((item) => item.startsWith("rh_"))) {
    return {
      packed_context: "",
      origin_refs: [],
      removed_or_summarized: [],
      reversibility: "none",
      token_estimate: 0,
      ...stubResponse(semanticStub.state, semanticStub.message, {
        limitations: semanticStub.limitations,
        staleness_hint: semanticStub.staleness_hint,
      }),
    };
  }

  const limitations = new Set<string>();
  const segments: PackSegment[] = [];
  let sourceReversibility: ReadStoredPackHandleResult["reversibility"] = "full";

  for (const source of sources) {
    const result = buildPackSegmentsFromSource(cwd, semanticStub, source, goal, style);
    for (const limitation of result.limitations) {
      limitations.add(limitation);
    }
    for (const segment of result.segments) {
      segments.push(segment);
    }
    sourceReversibility = compareReversibility(sourceReversibility, result.reversibility);
  }

  if (segments.length === 0) {
    return {
      packed_context: "",
      origin_refs: [],
      removed_or_summarized: [],
      reversibility: "none",
      token_estimate: 0,
      ...stubResponse("falha", "Não foi possível empacotar: fontes insuficientes ou inexistentes.", {
        limitations: Array.from(limitations),
        staleness_hint: semanticStub.staleness_hint,
      }),
    };
  }

  const header = [`Objetivo: ${goal}`, `Estilo: ${style}`, `Fontes: ${sources.join(", ")}`].join("\n");
  let remainingBudget = tokenBudget - approximateTokenCount(header);
  if (remainingBudget <= 0) {
    return {
      packed_context: "",
      origin_refs: [],
      removed_or_summarized: [],
      reversibility: "none",
      token_estimate: approximateTokenCount(header),
      ...stubResponse("falha", "token_budget insuficiente para montar contexto útil."),
    };
  }

  const includedSections: string[] = [header];
  const originRefs: PackOriginRef[] = [];
  const removedOrSummarized: PackRemovedEntry[] = [];
  let hadMaterialLoss = false;

  for (const segment of segments) {
    const segmentText = `\n\n${segment.text}`;
    const fullCost = approximateTokenCount(segmentText);
    if (fullCost <= remainingBudget) {
      includedSections.push(segmentText);
      originRefs.push(...segment.originRefs);
      remainingBudget -= fullCost;
      continue;
    }

    const summarizedLines = summarizeSegmentText(segment.text, remainingBudget);
    const summarizedText = `\n\n${summarizedLines}`;
    const summaryCost = approximateTokenCount(summarizedText);
    if (summaryCost <= remainingBudget) {
      includedSections.push(summarizedText);
      originRefs.push(...segment.originRefs);
      remainingBudget -= summaryCost;
      removedOrSummarized.push({
        ref: segment.ref,
        action: "summarized",
        reason: "budget",
        recoverable: true,
      });
      hadMaterialLoss = true;
      continue;
    }

    removedOrSummarized.push({
      ref: segment.ref,
      action: "removed",
      reason: "budget",
      recoverable: true,
    });
    hadMaterialLoss = true;
  }

  const packedContext = includedSections.join("");
  if (packedContext.trim().length === 0 || uniqueOriginRefs(originRefs).length === 0) {
    return {
      packed_context: "",
      origin_refs: [],
      removed_or_summarized: removedOrSummarized,
      reversibility: "none",
      token_estimate: approximateTokenCount(packedContext),
      ...stubResponse("falha", "Não foi possível empacotar: budget ou fontes insuficientes."),
    };
  }

  let retrieveHandle: string | undefined;
  let reversibility: ReadStoredPackHandleResult["reversibility"] = sourceReversibility;
  if (hadMaterialLoss) {
    retrieveHandle = `rh_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const storedReversibility = writeStoredPackHandle(cwd, {
      handle: retrieveHandle,
      created_at: new Date().toISOString(),
      goal,
      style,
      token_budget: tokenBudget,
      manifest_hash: semanticStub.structuralIndex?.manifest_hash ?? null,
      schema_version: semanticStub.schema_version,
      segments,
    });
    reversibility = compareReversibility(reversibility, storedReversibility);
    for (const item of removedOrSummarized) {
      item.recoverable = storedReversibility !== "none";
      item.via_handle = storedReversibility !== "none" ? retrieveHandle : undefined;
    }
    if (storedReversibility === "none") {
      limitations.add("Compressão irreversível: storage do retrieve_handle indisponível ou incompleto.");
    } else {
      limitations.add(
        "token_budget excedido; essencial preservado; ver removed_or_summarized e reutilize retrieve_handle em sources[].",
      );
    }
  }

  if (!hadMaterialLoss && reversibility === "full") {
    reversibility = sourceReversibility;
  }

  const state =
    semanticStub.state === "stale" ? "stale" : hadMaterialLoss || limitations.size > 0 ? "parcial" : "sucesso";

  return {
    packed_context: packedContext,
    origin_refs: uniqueOriginRefs(originRefs),
    removed_or_summarized: removedOrSummarized,
    retrieve_handle: retrieveHandle,
    reversibility,
    token_estimate: approximateTokenCount(packedContext),
    ...stubResponse(state, "Contexto comprimido pronto para o modelo.", {
      limitations: Array.from(limitations),
      staleness_hint: semanticStub.staleness_hint,
    }),
  };
}

function buildDiffImpactStub(
  cwd: string,
  semanticStub: SemanticStubEnvelope,
  args?: DiffImpactArgs,
): ToolStubPayload {
  const diffResult = readChangedFilesFromGit(cwd, args);
  if ("error" in diffResult) {
    return {
      changed_files: [],
      changed_symbols: [],
      affected_areas: [],
      affected_tests: [],
      risk_summary: "",
      ...stubResponse("falha", diffResult.error),
    };
  }

  const changedFiles = diffResult.changedFiles;
  const baseAreas = buildAffectedAreas(changedFiles);

  if (semanticStub.state === "falha" || !semanticStub.structuralIndex) {
    return {
      changed_files: changedFiles,
      changed_symbols: [],
      affected_areas: baseAreas,
      affected_tests: [],
      risk_summary: summarizeDiffImpactRisk(
        changedFiles.length,
        0,
        baseAreas.length,
        0,
        changedFiles.length,
      ),
      ...stubResponse(semanticStub.state, semanticStub.message, {
        limitations: semanticStub.limitations,
        staleness_hint: semanticStub.staleness_hint,
      }),
    };
  }

  const index = semanticStub.structuralIndex;
  const changedSymbols = extractChangedSymbols(index, changedFiles, diffResult.changedHunks);
  const affectedPaths = new Set<string>(changedFiles);
  const affectedTests = new Set<string>();
  const limitations = new Set<string>();
  let unresolvedFiles = 0;
  let uncertaintyCount = 0;
  let partialCoverage = false;

  for (const changedFile of changedFiles) {
    const impactPayload = buildImpactStub(cwd, semanticStub, {
      target: changedFile,
      direction: "dependents",
      depth: 3,
      include_tests: true,
    });

    if (impactPayload.state === "falha" || impactPayload.state === "ambigua") {
      unresolvedFiles += 1;
      continue;
    }

    for (const pathValue of (impactPayload.files as string[] | undefined) ?? []) {
      affectedPaths.add(pathValue);
      if (fileMatchesTests(pathValue)) {
        affectedTests.add(pathValue);
      }
      const language = index.files.find((entry) => entry.relative_path === pathValue)?.language;
      if (language ? index.coverage_by_language[language]?.coverage_level === "partial" : false) {
        partialCoverage = true;
      }
    }

    for (const pathValue of (impactPayload.tests as string[] | undefined) ?? []) {
      affectedTests.add(pathValue);
    }

    for (const limitation of (impactPayload.limitations as string[] | undefined) ?? []) {
      limitations.add(limitation);
    }

    const directAffected = Array.isArray(impactPayload.direct_affected)
      ? impactPayload.direct_affected.length
      : 0;
    const indirectAffected = Array.isArray(impactPayload.indirect_affected)
      ? impactPayload.indirect_affected.length
      : 0;

    if (impactPayload.state === "parcial") {
      uncertaintyCount += 1;
      if (directAffected + indirectAffected === 0) {
        unresolvedFiles += 1;
      }
    }
  }

  const affectedAreas = buildAffectedAreas(Array.from(affectedPaths));
  const riskSummary = summarizeDiffImpactRisk(
    changedFiles.length,
    changedSymbols.length,
    affectedAreas.length,
    affectedTests.size,
    unresolvedFiles,
  );
  const state =
    semanticStub.state === "stale"
      ? "stale"
      : unresolvedFiles > 0 || partialCoverage || uncertaintyCount > 0
        ? "parcial"
        : "sucesso";

  return {
    changed_files: changedFiles,
    changed_hunks: diffResult.changedHunks,
    changed_symbols: changedSymbols,
    affected_areas: affectedAreas,
    affected_tests: Array.from(affectedTests).sort((left, right) => left.localeCompare(right)),
    risk_summary: riskSummary,
    ...stubResponse(state, "Impacto provável do diff Git derivado do índice estrutural.", {
      limitations: Array.from(limitations),
      staleness_hint: semanticStub.staleness_hint,
    }),
  };
}

function _buildSymbolRefsLegacy(index: StructuralIndex): Map<string, SymbolRef[]> {
  const refs = new Map<string, SymbolRef[]>();
  for (const file of index.files) {
    for (const symbol of file.symbols) {
      const key = symbol.name.toLowerCase();
      const current = refs.get(key) ?? [];
      current.push({ file, symbol });
      refs.set(key, current);
    }
  }
  return refs;
}

function _traceNodeKeyLegacy(node: TraceNodeRef): string {
  return node.type === "file"
    ? `file:${node.file.relative_path}`
    : `symbol:${node.file.relative_path}:${node.symbol.name}:${node.symbol.start_line}`;
}

function _traceHopFromNodeLegacy(node: TraceNodeRef, relation: string): _TraceHop {
  if (node.type === "file") {
    return { relation, path: node.file.relative_path, kind: "file" };
  }
  return {
    relation,
    path: node.file.relative_path,
    symbol: node.symbol.name,
    kind: node.symbol.kind,
  };
}

function _resolveTraceTargetLegacy(
  index: StructuralIndex,
  rawTarget: string,
  symbolRefs: Map<string, SymbolRef[]>,
): { node: TraceNodeRef | null; ambiguous: ExploreRef[] } {
  const target = rawTarget.trim();
  const lowered = target.toLowerCase();
  const exactSymbols = symbolRefs.get(lowered) ?? [];
  if (exactSymbols.length === 1) {
    const match = exactSymbols[0]!;
    return { node: { type: "symbol", file: match.file, symbol: match.symbol }, ambiguous: [] };
  }
  if (exactSymbols.length > 1) {
    return {
      node: null,
      ambiguous: exactSymbols.slice(0, 10).map((match) => ({
        name: match.symbol.name,
        path: match.file.relative_path,
        kind: match.symbol.kind,
        reason: "exact_symbol_match",
      })),
    };
  }

  const fileSelection = selectFileTarget(index, target, true);
  if (fileSelection.entry) {
    return { node: { type: "file", file: fileSelection.entry }, ambiguous: [] };
  }
  return { node: null, ambiguous: fileSelection.candidates };
}

function _collectTraceNeighborsLegacy(
  index: StructuralIndex,
  node: TraceNodeRef,
  direction: "forward" | "backward" | "both",
  symbolRefs: Map<string, SymbolRef[]>,
): { neighbors: Array<{ node: TraceNodeRef; relation: string }>; uncertainty: TraceUncertaintyPoint[] } {
  const neighbors: Array<{ node: TraceNodeRef; relation: string }> = [];
  const uncertainty: TraceUncertaintyPoint[] = [];
  const dirs = direction === "both" ? (["forward", "backward"] as const) : [direction];

  for (const dir of dirs) {
    if (dir === "forward") {
      const sourceFile = node.file;

      for (const imported of sourceFile.imports) {
        if (!imported.resolved_path) {
          continue;
        }
        const targetFile = index.files.find((file) => file.relative_path === imported.resolved_path);
        if (targetFile) {
          neighbors.push({ node: { type: "file", file: targetFile }, relation: "imports" });
        }
      }

      for (const edge of sourceFile.edges) {
        if (edge.kind === "calls" || edge.kind === "extends" || edge.kind === "implements") {
          const matches = symbolRefs.get(edge.to.toLowerCase()) ?? [];
          if (matches.length === 1) {
            const match = matches[0]!;
            neighbors.push({
              node: { type: "symbol", file: match.file, symbol: match.symbol },
              relation: edge.kind,
            });
          } else if (matches.length > 1) {
            uncertainty.push({ reason: "multiple_symbol_targets", detail: `${edge.kind}:${edge.to}` });
          } else {
            uncertainty.push({ reason: "unresolved_symbol_target", detail: `${edge.kind}:${edge.to}` });
          }
        }
      }
    }

    if (dir === "backward") {
      for (const file of index.files) {
        if (file.relative_path === node.file.relative_path) {
          continue;
        }
        if (file.imports.some((item) => item.resolved_path === node.file.relative_path)) {
          neighbors.push({ node: { type: "file", file }, relation: "imported_by" });
        }
        if (node.type === "symbol") {
          for (const edge of file.edges) {
            if (
              (edge.kind === "calls" || edge.kind === "extends" || edge.kind === "implements") &&
              edge.to === node.symbol.name
            ) {
              const callerSymbol =
                edge.from_symbol != null
                  ? file.symbols.find((symbol) => symbol.name === edge.from_symbol) ?? null
                  : null;
              if (callerSymbol) {
                neighbors.push({
                  node: { type: "symbol", file, symbol: callerSymbol },
                  relation: `${edge.kind}_by`,
                });
              } else {
                neighbors.push({ node: { type: "file", file }, relation: `${edge.kind}_by` });
                uncertainty.push({
                  reason: "file_level_back_reference",
                  detail: `${file.relative_path}:${edge.kind}:${node.symbol.name}`,
                });
              }
            }
          }
        }
      }
    }
  }

  return {
    neighbors: uniqueByKey(neighbors, (item) => `${_traceNodeKeyLegacy(item.node)}:${item.relation}`),
    uncertainty,
  };
}

function _matchesTraceDestinationLegacy(node: TraceNodeRef, rawTo: string | undefined): boolean {
  if (!rawTo) {
    return false;
  }
  const lowered = rawTo.trim().toLowerCase();
  if (node.type === "file") {
    return node.file.relative_path.toLowerCase() === lowered;
  }
  return node.symbol.name.toLowerCase() === lowered || node.file.relative_path.toLowerCase() === lowered;
}

function buildExploreStub(
  cwd: string,
  semanticStub: SemanticStubEnvelope,
  args?: ExploreArgs,
): ToolStubPayload {
  const target = args?.target?.trim() ?? "";
  if (!target) {
    return {
      summary: "",
      central_symbols: [],
      relevant_files: [],
      imports: [],
      callers: [],
      callees: [],
      snippets: [],
      suggested_next_action: "",
      ...stubResponse("falha", "Input inválido para a tool"),
    };
  }

  if (semanticStub.state === "falha" || !semanticStub.structuralIndex) {
    return {
      summary: "",
      central_symbols: [],
      relevant_files: [],
      imports: [],
      callers: [],
      callees: [],
      snippets: [],
      suggested_next_action: "",
      ...stubResponse(semanticStub.state, semanticStub.message, {
        limitations: semanticStub.limitations,
        staleness_hint: semanticStub.staleness_hint,
      }),
    };
  }

  const index = semanticStub.structuralIndex;
  const includeTests = args?.include_tests ?? false;
  const budget = Math.max(1, Math.min(args?.budget ?? 6, 20));
  const mode = args?.mode ?? "symbol";
  let entry: FileStructuralEntry | null = null;
  let targetSymbol: ExtractedSymbol | null = null;
  let ambiguityCandidates: ExploreRef[] = [];

  if (mode === "file") {
    const selection = selectFileTarget(index, target, includeTests);
    entry = selection.entry;
    ambiguityCandidates = selection.candidates;
  } else {
    const metadata = readWorkspaceMetadata(cwd);
    if (!metadata) {
      return {
        summary: "",
        central_symbols: [],
        relevant_files: [],
        imports: [],
        callers: [],
        callees: [],
        snippets: [],
        suggested_next_action: "",
        ...stubResponse("falha", WORKSPACE_MISSING),
      };
    }
    const db = openIndexDb(getIndexDbPath(metadata.root_path), { readonly: true });
    try {
      const hits = searchFtsInternal(db, target, budget);
      const exactHits = hits.filter((hit) => hit.name.toLowerCase() === target.toLowerCase());
      if (mode === "topic") {
        const topicFiles = hits
          .map((hit) => index.files.find((file) => file.relative_path === hit.relative_path))
          .filter((file): file is FileStructuralEntry => Boolean(file));
        const uniqueFiles = uniqueByKey(topicFiles, (file) => file.relative_path);
        if (uniqueFiles.length === 1) {
          entry = uniqueFiles[0]!;
        } else {
          ambiguityCandidates = uniqueFiles.slice(0, 10).map((file) => ({
            name: file.relative_path,
            path: file.relative_path,
            reason: "topic_match",
          }));
        }
      } else if (exactHits.length === 1) {
        const hit = exactHits[0]!;
        entry = index.files.find((file) => file.relative_path === hit.relative_path) ?? null;
        targetSymbol = entry?.symbols.find((symbol) => symbol.name === hit.name) ?? null;
      } else if (exactHits.length > 1) {
        ambiguityCandidates = exactHits.slice(0, 10).map((hit) => ({
          name: hit.name,
          path: hit.relative_path,
          kind: hit.kind,
          reason: "exact_symbol_match",
        }));
      } else if (hits.length === 1) {
        const hit = hits[0]!;
        entry = index.files.find((file) => file.relative_path === hit.relative_path) ?? null;
        targetSymbol = entry?.symbols.find((symbol) => symbol.name === hit.name) ?? null;
      } else if (hits.length > 1) {
        ambiguityCandidates = hits.slice(0, 10).map((hit) => ({
          name: hit.name,
          path: hit.relative_path,
          kind: hit.kind,
          reason: "fts_candidate",
        }));
      }
    } finally {
      closeIndexDb(db);
    }
  }

  if (!entry) {
    const state = ambiguityCandidates.length > 1 ? "ambigua" : "falha";
    return {
      summary: "",
      central_symbols: [],
      relevant_files: [],
      imports: [],
      callers: [],
      callees: [],
      snippets: [],
      suggested_next_action:
        ambiguityCandidates.length > 1
          ? "Refine a query com path, nome exato ou use `cortex search` para desambiguar."
          : "Use `cortex search` ou `cortex files` para localizar um alvo indexado válido.",
      candidates: ambiguityCandidates,
      ...stubResponse(
        state,
        ambiguityCandidates.length > 1
          ? "Múltiplos alvos possíveis para explore; refine o target."
          : "E_INSUFFICIENT_EVIDENCE: Alvo não resolvido no índice atual.",
        {
          limitations:
            state === "ambigua" ? ["Explore v1 exige um alvo resolvido de forma suficientemente específica."] : undefined,
          staleness_hint: semanticStub.staleness_hint,
        },
      ),
    };
  }

  const centralSymbolPool = targetSymbol
    ? [targetSymbol, ...entry.symbols.filter((symbol) => symbol.name !== targetSymbol.name)]
    : entry.symbols;
  const centralSymbols = centralSymbolPool.slice(0, Math.max(1, Math.min(args?.depth ?? 3, 5)));
  const relevantFiles = collectFileRelevantFiles(index, entry, includeTests, budget);
  const imports = entry.imports.slice(0, budget);
  const { callers, callees } = collectCallersAndCallees(index, entry, targetSymbol, includeTests, budget);
  const snippets = buildSnippetRefs(entry, centralSymbols, budget);

  const partialCoverage = index.coverage_by_language[entry.language]?.coverage_level === "partial";
  const state =
    semanticStub.state === "stale"
      ? "stale"
      : partialCoverage || mode === "topic"
        ? "parcial"
        : "sucesso";
  const limitations = [
    ...(semanticStub.limitations ?? []),
    ...(partialCoverage
      ? [`Cobertura ${entry.language} é parcial para explore v1; callers/callees podem estar incompletos.`]
      : []),
    ...(targetSymbol
      ? ["Chamadas sem import resolvido podem degradar para correspondência global por nome."]
      : ["Exploração de arquivo combina símbolos, imports e relações estruturais indexadas."]),
  ];

  const targetLabel = targetSymbol ? `Símbolo ${targetSymbol.name}` : `Arquivo ${entry.relative_path}`;

  return {
    summary: buildExploreSummary(
      targetLabel,
      entry,
      centralSymbols,
      imports.length,
      callers.length,
      callees.length,
    ),
    central_symbols: centralSymbols.map((symbol) => ({
      name: symbol.name,
      kind: symbol.kind,
      path: entry!.relative_path,
      start_line: symbol.start_line,
      end_line: symbol.end_line,
      exported: symbol.exported ?? false,
    })),
    relevant_files: relevantFiles,
    imports,
    callers,
    callees,
    snippets,
    suggested_next_action: targetSymbol
      ? "Use `trace` para fluxo ou `impact` para blast radius do símbolo."
      : "Refine para um símbolo com `search` se precisar entendimento mais específico dentro do arquivo.",
    ...stubResponse(state, "Exploração estrutural composta concluída.", {
      limitations,
      staleness_hint: semanticStub.staleness_hint,
    }),
  };
}

function _buildTraceStubLegacy(
  _semanticStub: SemanticStubEnvelope,
  _args?: TraceArgs,
): ToolStubPayload {
  return {
    paths: [],
    uncertainty_points: [],
    ...stubResponse("falha", "Legacy trace helper should not be used."),
  };
}

void [
  _buildSymbolRefsLegacy,
  _traceNodeKeyLegacy,
  _traceHopFromNodeLegacy,
  _resolveTraceTargetLegacy,
  _collectTraceNeighborsLegacy,
  _matchesTraceDestinationLegacy,
  _buildTraceStubLegacy,
];

function applyFilesFilters(
  tree: Array<{ path: string; symbol_counts?: unknown }>,
  args?: FilesArgs,
): Array<{ path: string; symbol_counts?: unknown }> {
  let filtered = tree;

  if (args?.pattern) {
    const pattern = args.pattern.toLowerCase();
    filtered = filtered.filter((entry) => entry.path.toLowerCase().includes(pattern));
  }

  if (typeof args?.max_depth === "number") {
    filtered = filtered.filter((entry) => entry.path.split("/").length - 1 <= args.max_depth!);
  }

  return filtered;
}

function isWithinPath(rootPath: string, candidatePath: string): boolean {
  const canonicalPath = (path: string): string => {
    const absolutePath = resolve(path);
    if (existsSync(absolutePath)) {
      return realpathSync.native(absolutePath);
    }
    const missingParts: string[] = [];
    let ancestor = absolutePath;
    while (!existsSync(ancestor)) {
      missingParts.unshift(basename(ancestor));
      const parent = dirname(ancestor);
      if (parent === ancestor) {
        return absolutePath;
      }
      ancestor = parent;
    }
    return join(realpathSync.native(ancestor), ...missingParts);
  };
  const relativePath = normalizeRelativePath(
    relative(canonicalPath(rootPath), canonicalPath(candidatePath)),
  );
  return relativePath === "" || (!relativePath.startsWith("../") && relativePath !== "..");
}

/** Stubs honestos por tool — campos vazios alinhados a SURFACE_MCP_CLI.md (S02) */
export type ResponseFormat = "concise" | "detailed";

// Default conciso: o envelope de honestidade (confidence/message/limitations em
// prosa pt-br) custa ~50-70% dos tokens de envelope e quase tudo é derivável de
// `state` ou de um código `E_*`. `detailed` restaura a prosa completa.
let defaultResponseFormat: ResponseFormat = "concise";

export function setDefaultResponseFormat(format: ResponseFormat): void {
  defaultResponseFormat = format;
}

function resolveResponseFormat(args?: Record<string, unknown>): ResponseFormat {
  const raw = args?.response_format;
  return raw === "detailed" || raw === "concise" ? raw : defaultResponseFormat;
}

// Extrai o código de sinal (`E_…` / `W_…`) de uma string de envelope, descartando
// a prosa que vem depois de `: `. Retorna `undefined` quando não há código.
const ENVELOPE_CODE = /^([EW]_[A-Z0-9_]+)\b/;
function envelopeCode(text: string | undefined): string | undefined {
  if (!text) {
    return undefined;
  }
  const match = ENVELOPE_CODE.exec(text);
  return match ? match[1] : undefined;
}

/**
 * Pós-processa o envelope para o formato pedido. Em `concise` (default) o
 * envelope cai ao sinal mínimo:
 *  - `confidence` dropado (100% derivável de `state`);
 *  - `message` mantém só o código `E_*`; prosa estática (sucesso) some;
 *  - `limitations` e `staleness_hint` (prosa pt-br) saem — `state` já carrega o
 *    sinal operacional; a prosa volta em `detailed`.
 * Campos de domínio (candidates, hops, tree, …) são preservados intactos.
 */
function applyResponseFormat(
  payload: ToolStubPayload,
  format: ResponseFormat,
): ToolStubPayload {
  if (format === "detailed") {
    return payload;
  }

  const { message, confidence, limitations, staleness_hint, ...rest } = payload;
  void confidence;
  void limitations;
  void staleness_hint;
  const out = rest as ToolStubPayload;

  const messageCode = envelopeCode(typeof message === "string" ? message : undefined);
  if (messageCode) {
    out.message = messageCode;
  }

  return out;
}

export function buildToolStub(
  tool: McpToolName,
  cwd: string = process.cwd(),
  args?: Record<string, unknown>,
): ToolStubPayload {
  return applyResponseFormat(
    buildToolStubInner(tool, cwd, args),
    resolveResponseFormat(args),
  );
}

function buildToolStubInner(
  tool: McpToolName,
  cwd: string = process.cwd(),
  args?: Record<string, unknown>,
): ToolStubPayload {
  if (tool === "status" && !isWithinPath(process.cwd(), cwd)) {
    const currentWorkspace = readWorkspaceMetadata(process.cwd());
    if (!currentWorkspace || !isWithinPath(currentWorkspace.root_path, cwd)) {
      return {
        initialized: false,
        staleness: "unknown",
        pending_files_count: 0,
        coverage_by_language: {},
        ...stubResponse(
          "falha",
          "E_PATH_OUTSIDE_WORKSPACE: `path` precisa permanecer no workspace atual.",
        ),
      };
    }
  }

  if (!readWorkspaceMetadata(cwd) && tool !== "status") {
    return {
      ...stubResponse("falha", WORKSPACE_MISSING),
    };
  }

  // search/files não precisam do grafo: carregam meta-only e resolvem
  // cobertura/tree por query alvo, matando o full-load no caminho quente.
  const mode: StructuralLoadMode = tool === "search" || tool === "files" ? "lite" : "full";
  const semanticStub = buildSemanticStubEnvelope(cwd, mode);

  switch (tool) {
    case "search":
      return buildSearchStub(cwd, semanticStub, args as SearchArgs | undefined);
    case "explore":
      return buildExploreStub(cwd, semanticStub, args as ExploreArgs | undefined);
    case "trace":
      return buildTraceStub(cwd, semanticStub, args as TraceArgs | undefined);
    case "impact":
      return buildImpactStub(cwd, semanticStub, args as ImpactArgs | undefined);
    case "diff_impact":
      return buildDiffImpactStub(cwd, semanticStub, args as DiffImpactArgs | undefined);
    case "files":
      {
        const payload = buildFilesStub(cwd, semanticStub);
        if (Array.isArray(payload.tree)) {
          payload.tree = applyFilesFilters(
            payload.tree as Array<{ path: string; symbol_counts?: unknown }>,
            args as FilesArgs | undefined,
          );
        }
        return payload;
      }
    case "pack_context":
      return buildPackContextStub(cwd, semanticStub, args as PackContextArgs | undefined);
    case "retrieve":
      return buildRetrieveStub(cwd, args as RetrieveArgs | undefined);
    case "status":
      return buildStatusStub(cwd);
  }
}

export { STRUCTURAL_INDEX_SCHEMA_VERSION, SQLITE_SCHEMA_VERSION };
