// Núcleo compartilhado das tools: tipos, envelope de índice, staleness e helpers.
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { ResponseState, OperationalEnvelope } from "../../contracts/response-state.js";
import type { DiscoveryManifest } from "../../discovery/types.js";
import { ManifestCorruptedError, readManifest } from "../../discovery/manifest.js";
import { computeManifestStaleness } from "../../discovery/staleness.js";
import type { StructuralIndex } from "../../extraction/types.js";
import { IndexDbCorruptedError, IndexDbSchemaError, loadStructuralIndexForRead, loadStructuralMetaForRead } from "../../storage/index-persistence.js";
import { getManifestPath, readWorkspaceMetadata, resolveRespectGitignore } from "../../workspace/workspace.js";

export interface ToolResponsePayload extends OperationalEnvelope {
  [key: string]: unknown;
}

export interface SearchArgs {
  query?: string;
  scope?: string;
  kind?: string;
  limit?: number;
}

export interface FilesArgs {
  pattern?: string;
  max_depth?: number;
}

export interface ExploreArgs {
  target?: string;
  mode?: "symbol" | "file" | "topic";
  depth?: number;
  include_tests?: boolean;
  budget?: number;
}

export interface TraceArgs {
  from?: string;
  to?: string;
  direction?: "forward" | "backward" | "both";
  max_hops?: number;
}

export interface ImpactArgs {
  target?: string;
  direction?: "dependents" | "dependencies" | "both";
  depth?: number;
  include_tests?: boolean;
  summary_only?: boolean;
}

export interface DiffImpactArgs {
  scope?: "unstaged" | "staged" | "all" | "compare";
  base_ref?: string;
}

export interface PackContextArgs {
  sources?: string[];
  goal?: string;
  token_budget?: number;
  style?: "brief" | "balanced" | "deep";
  synthesize?: boolean;
}

export interface RetrieveArgs {
  handle?: string;
  // Body-on-demand: quando > 0, expande os origin_refs do handle lendo o
  // código real do disco com ± context_lines de padding ao redor do range.
  context_lines?: number;
}

export const INDEX_MISSING = "E_INDEX_MISSING: Índice não inicializado; execute init/index";

export const STALE_INDEX = "E_STALE_INDEX: Índice desatualizado; resultados podem estar incompletos";

export const WORKSPACE_MISSING =
  "E_WORKSPACE_INVALID: Workspace não preparado ou path inválido. Execute argus init.";

export const STRUCTURAL_INDEX_MISSING =
  "E_INDEX_MISSING: Manifest disponível; índice estrutural ausente — execute argus index ou argus sync.";

// Códigos de staleness_hint — prefixam a prosa em `detailed`; `concise` já dropa o campo.
export const STALE_RUN_SYNC = "STALE_RUN_SYNC";
export const STALE_RUN_INDEX = "STALE_RUN_INDEX";
export const STALE_RUN_EMBED = "STALE_RUN_EMBED";
export const STALE_UNKNOWN = "STALE_UNKNOWN";

const FTS_RETRIEVAL_PENDING =
  "Índice lexical e estrutural disponível para retrieval local.";

export const PARTIAL_NO_MANIFEST_LIMITATIONS = [
  "Manifest de arquivos ausente; execute argus index para iniciar o inventário.",
];

export const PARTIAL_CORRUPTED_MANIFEST_LIMITATIONS = [
  "Manifest de arquivos corrompido; execute argus index para recriar o inventário.",
];

export const PARTIAL_STRUCTURAL_MISSING_LIMITATIONS = [
  "Manifest presente, mas índice SQLite ausente; execute argus index ou argus sync.",
];

const PARTIAL_FTS_LIMITATIONS = [
  "Resultados dependem da cobertura estrutural disponível para cada linguagem.",
];

export const PARTIAL_CORRUPTED_STRUCTURAL_LIMITATIONS = [
  "Índice SQLite corrompido; execute argus index para reconstruir.",
];

export interface IndexEnvelope {
  state: ResponseState;
  message: string;
  limitations?: string[];
  staleness_hint?: string;
  structuralIndex: StructuralIndex | null;
  storage_backend: "sqlite" | null;
  schema_version: string | null;
}

export interface SearchCandidate {
  id: string;
  kind: string;
  name: string;
  path: string;
  start_line: number;
  end_line: number;
  score: number;
  match_reason: string;
  confidence?: string;
  stale_reason?: string;
  contradiction_reason?: string;
  superseded_by?: string;
}

export interface ExploreSnippetRef {
  path: string;
  start_line: number;
  end_line: number;
  symbol?: string;
  // Assinatura (linha de declaração) sem o corpo — sempre presente quando legível.
  signature?: string;
  // Trecho verbatim limitado (balanced/deep). Ausente em brief.
  body?: string;
  // true quando o corpo do símbolo foi cortado pelos caps do style.
  truncated?: boolean;
}

export interface ExploreRef {
  // Omitido para refs file-level (`name` seria idêntico a `path`); presente só
  // para refs de símbolo (callers/callees), onde carrega o nome do símbolo.
  name?: string;
  path: string;
  kind?: string;
  reason?: string;
}

export interface TraceResolvedTarget {
  node?: TraceNode;
  candidates: ExploreRef[];
  limitations?: string[];
}

export interface TraceNode {
  id: string;
  node_type: "symbol" | "file";
  name: string;
  path: string;
  symbol_kind?: string;
  line?: number;
}

export interface TraceEdgeStep {
  relation: string;
  from: TraceNode;
  to: TraceNode;
  line?: number;
  uncertain?: string;
  weight?: number;
}

interface TraceHopPayload {
  relation: string;
  name: string;
  path: string;
  node_type: "symbol" | "file";
  symbol_kind?: string;
  line?: number;
}

export interface TracePathPayload {
  hops: TraceHopPayload[];
  files: string[];
  symbols: string[];
}

export interface TraceUncertaintyPoint {
  reason: string;
  path?: string;
  symbol?: string;
  relation?: string;
  detail?: string;
}

export interface ImpactRef {
  name: string;
  path: string;
  node_type: "symbol" | "file";
  symbol_kind?: string;
  depth: number;
  relation?: string;
}

export interface DiffImpactSymbol {
  name: string;
  path: string;
  kind?: string;
}

export interface DiffChangedHunk {
  path: string;
  start_line: number;
  line_count: number;
}

export interface PackOriginRef {
  ref: string;
  path: string;
  start_line?: number;
  end_line?: number;
  symbol?: string;
}

export interface PackRemovedEntry {
  ref: string;
  action: "removed" | "summarized" | "deduplicated";
  reason: "budget" | "low_relevance" | "duplicate";
  recoverable: boolean;
  via_handle?: string;
}

export interface PackSegment {
  ref: string;
  text: string;
  originRefs: PackOriginRef[];
}

export interface StoredPackHandle {
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

export interface ReadStoredPackHandleResult {
  found: boolean;
  segments: PackSegment[];
  limitations: string[];
  reversibility: "full" | "partial" | "none";
}

export type StructuralLoadMode = "full" | "lite";

export function loadStructuralIndex(
  rootPath: string,
  mode: StructuralLoadMode = "full",
): StructuralIndex | null {
  // `lite`: meta-only (files: []) para search/files, que resolvem cobertura e
  // tree por query alvo — evita o full-load (N+1 de símbolos/edges por arquivo).
  return mode === "lite"
    ? loadStructuralMetaForRead(rootPath)
    : loadStructuralIndexForRead(rootPath);
}

export function mergeStructuralLimitations(
  structural: StructuralIndex | null,
  base: string[] = [],
): string[] {
  if (!structural?.extraction_limitations?.length) {
    return base;
  }
  return [...base, ...structural.extraction_limitations];
}

export function buildIndexVersion(manifest: DiscoveryManifest, structural: StructuralIndex | null): string {
  if (structural) {
    return `${manifest.schema_version}+sqlite@${structural.schema_version}`;
  }
  return manifest.schema_version;
}

export function buildIndexEnvelope(
  cwd: string,
  mode: StructuralLoadMode = "full",
): IndexEnvelope {
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
        staleness_hint: `${STALE_RUN_INDEX}: Execute argus index para reconstruir o manifest.`,
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
      staleness_hint: `${STALE_RUN_INDEX}: Execute argus index para criar o manifest inicial.`,
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
      staleness_hint: `${STALE_RUN_SYNC}: Execute argus sync para sincronizar o delta pendente.`,
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
      staleness_hint: `${STALE_UNKNOWN}: Não foi possível determinar staleness com segurança.`,
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
      staleness_hint: `${STALE_RUN_INDEX}: Execute argus index ou argus sync para gerar o índice SQLite.`,
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

export function uniqueByKey<T>(items: T[], getKey: (item: T) => string): T[] {
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

export function fileMatchesTests(relativePath: string): boolean {
  return /(^|\/)(test|tests|__tests__)\//.test(relativePath) || /\.test\./.test(relativePath);
}

export function normalizeRelativePath(pathValue: string): string {
  return pathValue.split("\\").join("/");
}

export function isWithinPath(rootPath: string, candidatePath: string): boolean {
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
