// Tools `pack_context`/`retrieve`: empacotamento e recuperação por handle.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { stubResponse } from "../../contracts/response-state.js";
import type { StructuralIndex } from "../../extraction/types.js";
import { closeIndexDb, openIndexDb } from "../../storage/sqlite-index-store.js";
import { getIndexDbPath, readWorkspaceMetadata } from "../../workspace/workspace.js";
import { getVaultDir } from "../../memory/paths.js";
import { openMemoryDb, closeMemoryDb } from "../../memory/storage/sqlite-db.js";
import { uniqueByKey, isWithinPath } from "./common.js";
import type { ToolResponsePayload, PackContextArgs, RetrieveArgs, IndexEnvelope, ExploreSnippetRef, PackOriginRef, PackRemovedEntry, PackSegment, StoredPackHandle, ReadStoredPackHandleResult, TraceNode } from "./common.js";
import { LazyTraceGraph, personalizedPageRank } from "./graph.js";
import { buildExploreResponse } from "./explore.js";
import { countTokens } from "../../packing/tokenizer.js";
import {
  buildActionableSnippet,
  formatSnippetBlock,
  getSnippetStyleCaps,
  type SnippetStyle,
} from "./snippet-builder.js";

/** Re-export para consumidores externos do seam de assinatura. */
export { readSymbolSignature } from "./snippet-builder.js";

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
  while (kept.length > 1 && countTokens(`\n\n${kept.join("\n")}`) > budget) {
    kept = kept.slice(0, -1);
  }
  return kept.join("\n");
}

function getPackStyleConfig(style: NonNullable<PackContextArgs["style"]>): {
  depth: number;
  budget: number;
  snippetLimit: number;
  snippetStyle: SnippetStyle;
} {
  const caps = getSnippetStyleCaps(style);
  return {
    depth: caps.depth,
    budget: caps.budget,
    snippetLimit: caps.snippetLimit,
    snippetStyle: style,
  };
}

function getPackedHandlesDir(cwd: string): string {
  return join(cwd, ".argus", "packed-handles");
}

function getPackedHandlePath(cwd: string, handle: string): string {
  return join(getPackedHandlesDir(cwd), handle);
}

function isValidRetrieveHandle(handle: string): boolean {
  return /^(rh|mh)_[a-f0-9]{16}$/.test(handle);
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

// GC de retrieve handles: `.argus/packed-handles/` crescia sem limite (um
// diretório por pack com perda de budget). Evicção por idade (TTL) e por
// contagem (cap dos mais recentes), disparada ao gravar um novo handle.
const PACKED_HANDLE_MAX = 50;

const PACKED_HANDLE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function evictStalePackedHandles(cwd: string, protectedHandle: string): void {
  try {
    const db = openIndexDb(getIndexDbPath(cwd));
    try {
      const rows = db
        .prepare(
          `SELECT handle, created_at FROM packed_handles
           ORDER BY CASE WHEN handle = ? THEN 0 ELSE 1 END, created_at DESC, id DESC`,
        )
        .all(protectedHandle) as Array<{ handle: string; created_at: string }>;
      const now = Date.now();
      const del = db.prepare("DELETE FROM packed_handles WHERE handle = ?");
      const handlesDir = getPackedHandlesDir(cwd);
      let retained = 0;
      rows.forEach((row) => {
        const parsed = Date.parse(row.created_at);
        const isProtected = row.handle === protectedHandle;
        const tooOld = !isProtected && Number.isFinite(parsed) && now - parsed > PACKED_HANDLE_TTL_MS;
        const overflow = !isProtected && retained >= PACKED_HANDLE_MAX;
        if (!tooOld && !overflow) {
          retained += 1;
          return;
        }
        if (isValidRetrieveHandle(row.handle)) {
          const dir = getPackedHandlePath(cwd, row.handle);
          if (isWithinPath(handlesDir, dir)) {
            rmSync(dir, { recursive: true, force: true });
          }
        }
        del.run(row.handle);
      });
    } finally {
      closeIndexDb(db);
    }
  } catch {
    // best effort; nunca falha o pack_context por causa da limpeza
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

export function buildRetrieveResponse(cwd: string, args?: RetrieveArgs): ToolResponsePayload {
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

  // Body-on-demand: com context_lines > 0, expande os origin_refs lendo o
  // código real do disco com padding ao redor do range. Cada arquivo é lido
  // uma vez (cache local) e validado contra o workspace antes da leitura.
  const contextLines = Math.max(0, Math.min(args?.context_lines ?? 0, 100));
  if (contextLines > 0) {
    const fileCache = new Map<string, string[] | null>();
    const readLines = (relativePath: string): string[] | null => {
      if (fileCache.has(relativePath)) {
        return fileCache.get(relativePath) ?? null;
      }
      const absolutePath = join(cwd, relativePath);
      const value = isWithinPath(cwd, absolutePath)
        ? (() => {
            try {
              return readFileSync(absolutePath, "utf-8").split("\n");
            } catch {
              return null;
            }
          })()
        : null;
      fileCache.set(relativePath, value);
      return value;
    };
    const expandedBlocks: string[] = [];
    const expandLimitations: string[] = [];
    for (const ref of originRefs) {
      if (ref.start_line === undefined || ref.end_line === undefined) {
        continue;
      }
      const lines = readLines(ref.path);
      if (!lines) {
        expandLimitations.push(`Origin ref fora do workspace ou ilegível: ${ref.path}.`);
        continue;
      }
      const from = Math.max(0, ref.start_line - 1 - contextLines);
      const to = Math.min(lines.length, ref.end_line + contextLines);
      const body = lines.slice(from, to).join("\n").trim();
      if (body) {
        expandedBlocks.push(`${ref.symbol ?? ref.path}@${ref.path}:${from + 1}-${to}\n${body}`);
      }
    }
    if (expandedBlocks.length > 0) {
      return {
        handle,
        content: expandedBlocks.join("\n\n"),
        origin_refs: originRefs,
        segment_count: stored.segments.length,
        context_lines: contextLines,
        reversibility: stored.reversibility,
        ...stubResponse(
          expandLimitations.length > 0 ? "parcial" : "sucesso",
          "Corpos expandidos sob demanda a partir dos origin_refs.",
          { limitations: [...stored.limitations, ...expandLimitations] },
        ),
      };
    }
  }

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
  evictStalePackedHandles(cwd, payload.handle);
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

function sourceLooksLikeIndexedFile(index: StructuralIndex, source: string): boolean {
  return index.files.some((entry) => entry.relative_path === source);
}

function buildPackSegmentsFromSource(
  cwd: string,
  envelope: IndexEnvelope,
  source: string,
  goal: string,
  style: NonNullable<PackContextArgs["style"]>,
): {
  segments: PackSegment[];
  limitations: string[];
  reversibility: ReadStoredPackHandleResult["reversibility"];
  hadSnippetTruncation: boolean;
} {
  const trimmed = source.trim();
  if (!trimmed) {
    return { segments: [], limitations: [], reversibility: "full", hadSnippetTruncation: false };
  }

  if (trimmed.startsWith("rh_") || trimmed.startsWith("mh_")) {
    const stored = readStoredPackHandle(cwd, trimmed);
    if (!stored.found) {
      return {
        segments: [],
        limitations: [`Retrieve handle não encontrado: ${trimmed}.`],
        reversibility: "none",
        hadSnippetTruncation: false,
      };
    }
    return {
      segments: stored.segments,
      limitations: stored.limitations,
      reversibility: stored.reversibility,
      hadSnippetTruncation: false,
    };
  }

  const memorySegment = buildMemoryPackSegment(cwd, trimmed);
  if (memorySegment) {
    return {
      segments: [memorySegment],
      limitations: [],
      reversibility: "full",
      hadSnippetTruncation: false,
    };
  }

  if (!envelope.structuralIndex) {
    return {
      segments: [],
      limitations: ["Índice estrutural indisponível para empacotar fontes locais."],
      reversibility: "none",
      hadSnippetTruncation: false,
    };
  }

  const config = getPackStyleConfig(style);
  const mode = sourceLooksLikeIndexedFile(envelope.structuralIndex, trimmed) ? "file" : "symbol";
  const payload = buildExploreResponse(cwd, envelope, {
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
      hadSnippetTruncation: false,
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
  const memoryRefs = (payload.memory_refs as Array<{
    path: string;
    title: string;
    mechanism?: string;
    confidence?: string;
    evidence?: string;
  }> | undefined) ?? [];
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
  // Reconstrói snippets com o style do pack (explore default é balanced; brief/deep divergem).
  const styledSnippets = snippets.map((snippet) =>
    buildActionableSnippet(
      cwd,
      snippet.path,
      snippet.start_line,
      snippet.end_line,
      snippet.symbol,
      config.snippetStyle,
    ),
  );
  const snippetBlocks = styledSnippets
    .map((snippet) => formatSnippetBlock(snippet, config.snippetStyle))
    .filter((item) => item.trim().length > 0);
  const hadSnippetTruncation = styledSnippets.some((s) => s.truncated === true);

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
    memoryRefs.length > 0
      ? `Notas relacionadas (grafo): ${memoryRefs
          .map((item) => `${item.title} [${item.mechanism ?? "graph"}/${item.confidence ?? "inferred"}]`)
          .join("; ")}`
      : null,
    ...snippetBlocks,
  ].filter((item): item is string => Boolean(item && item.trim().length > 0));

  const segments: PackSegment[] = [
    {
      ref: trimmed,
      text: lines.join("\n"),
      originRefs,
    },
  ];

  for (const memoryRef of memoryRefs.slice(0, 3)) {
    const related = buildMemoryPackSegment(cwd, `memory:${memoryRef.path}`);
    if (!related) {
      continue;
    }
    related.text = [
      `Relação: ${memoryRef.mechanism ?? "graph"} (${memoryRef.confidence ?? "inferred"})`,
      memoryRef.evidence ? `Evidência: ${memoryRef.evidence}` : null,
      related.text,
    ]
      .filter((item): item is string => Boolean(item))
      .join("\n");
    segments.push(related);
  }

  return {
    segments,
    limitations: ((payload.limitations as string[] | undefined) ?? []).slice(0, 4),
    reversibility: "full",
    hadSnippetTruncation,
  };
}

function buildMemoryPackSegment(cwd: string, source: string): PackSegment | null {
  if (source.startsWith("memory:")) {
    const rel = source.slice("memory:".length).replace(/^\/+/, "");
    const vaultDir = getVaultDir(cwd);
    const path = join(vaultDir, rel);
    if (!isWithinPath(vaultDir, path) || !existsSync(path)) {
      return null;
    }
    const text = readFileSync(path, "utf-8");
    return {
      ref: source,
      text: [`Fonte: ${source}`, `Título: ${basename(rel)}`, "---", text.trim()].join("\n"),
      originRefs: [{ ref: source, path: `memory/${rel}` }],
    };
  }

  if (source.startsWith("note:")) {
    const id = source.slice("note:".length).trim();
    if (!id) {
      return null;
    }
    try {
      const db = openMemoryDb(cwd, { readonly: true });
      try {
        const row = db
          .prepare("SELECT id, path, title, content FROM notes WHERE id = ? OR path = ? LIMIT 1")
          .get(id, id) as { id: string; path: string; title: string; content: string } | undefined;
        if (!row) {
          return null;
        }
        return {
          ref: source,
          text: [`Fonte: note:${row.id}`, `Título: ${row.title}`, "---", row.content.trim()].join("\n"),
          originRefs: [{ ref: source, path: `memory/${row.path}`, symbol: row.title }],
        };
      } finally {
        closeMemoryDb(db);
      }
    } catch {
      return null;
    }
  }

  return null;
}

function rankSegmentsByLazyPageRank(cwd: string, segments: PackSegment[]): PackSegment[] {
  const metadata = readWorkspaceMetadata(cwd);
  if (!metadata || segments.length <= 1) {
    return segments;
  }

  try {
    const db = openIndexDb(getIndexDbPath(metadata.root_path), { readonly: true });
    try {
      const graph = new LazyTraceGraph(db, true);
      const seedNodes = uniqueByKey(
        segments
          .flatMap((segment) => segment.originRefs.map((ref) => ref.path))
          .map((path): TraceNode => ({
            id: `file:${path}`,
            node_type: "file",
            name: path,
            path,
          })),
        (node) => node.id,
      );

      for (const seed of seedNodes) {
        const firstHop = graph.outEdges(seed);
        for (const edge of firstHop.slice(0, 20)) {
          graph.outEdges(edge.to);
        }
      }

      const pageRank = personalizedPageRank(
        graph.discovered,
        seedNodes.map((node) => node.id),
      );
      if (pageRank.size === 0) {
        return segments;
      }

      const scoreSegment = (segment: PackSegment): number =>
        segment.originRefs.reduce(
          (max, ref) => Math.max(max, pageRank.get(`file:${ref.path}`) ?? 0),
          0,
        );
      return segments
        .map((segment, index) => ({ segment, index, score: scoreSegment(segment) }))
        .sort((left, right) => right.score - left.score || left.index - right.index)
        .map((scored) => scored.segment);
    } finally {
      closeIndexDb(db);
    }
  } catch {
    return segments;
  }
}

export function buildPackContextResponse(
  cwd: string,
  envelope: IndexEnvelope,
  args?: PackContextArgs,
): ToolResponsePayload {
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

  const sourceIsMemoryOnly = (item: string) =>
    item.startsWith("rh_") || item.startsWith("mh_") || item.startsWith("memory:") || item.startsWith("note:");

  if (envelope.state === "falha" && !sources.every(sourceIsMemoryOnly)) {
    return {
      packed_context: "",
      origin_refs: [],
      removed_or_summarized: [],
      reversibility: "none",
      token_estimate: 0,
      ...stubResponse(envelope.state, envelope.message, {
        limitations: envelope.limitations,
        staleness_hint: envelope.staleness_hint,
      }),
    };
  }

  const limitations = new Set<string>();
  const segments: PackSegment[] = [];
  let sourceReversibility: ReadStoredPackHandleResult["reversibility"] = "full";
  let hadSnippetTruncation = false;

  for (const source of sources) {
    const result = buildPackSegmentsFromSource(cwd, envelope, source, goal, style);
    for (const limitation of result.limitations) {
      limitations.add(limitation);
    }
    for (const segment of result.segments) {
      segments.push(segment);
    }
    sourceReversibility = compareReversibility(sourceReversibility, result.reversibility);
    if (result.hadSnippetTruncation) {
      hadSnippetTruncation = true;
    }
  }

  // Item 14: PageRank personalizado no subgrafo curto das fontes, via
  // LazyTraceGraph. Evita reconstruir o grafo inteiro só para ordenar segmentos.
  segments.splice(0, segments.length, ...rankSegmentsByLazyPageRank(cwd, segments));

  if (segments.length === 0) {
    return {
      packed_context: "",
      origin_refs: [],
      removed_or_summarized: [],
      reversibility: "none",
      token_estimate: 0,
      ...stubResponse("falha", "Não foi possível empacotar: fontes insuficientes ou inexistentes.", {
        limitations: Array.from(limitations),
        staleness_hint: envelope.staleness_hint,
      }),
    };
  }

  const header = [`Objetivo: ${goal}`, `Estilo: ${style}`, `Fontes: ${sources.join(", ")}`].join("\n");
  let remainingBudget = tokenBudget - countTokens(header);
  if (remainingBudget <= 0) {
    return {
      packed_context: "",
      origin_refs: [],
      removed_or_summarized: [],
      reversibility: "none",
      token_estimate: countTokens(header),
      ...stubResponse("falha", "token_budget insuficiente para montar contexto útil."),
    };
  }

  const includedSections: string[] = [header];
  const originRefs: PackOriginRef[] = [];
  const removedOrSummarized: PackRemovedEntry[] = [];
  let hadMaterialLoss = false;

  for (const segment of segments) {
    const segmentText = `\n\n${segment.text}`;
    const fullCost = countTokens(segmentText);
    if (fullCost <= remainingBudget) {
      includedSections.push(segmentText);
      originRefs.push(...segment.originRefs);
      remainingBudget -= fullCost;
      continue;
    }

    const summarizedLines = summarizeSegmentText(segment.text, remainingBudget);
    const summarizedText = `\n\n${summarizedLines}`;
    const summaryCost = countTokens(summarizedText);
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
      token_estimate: countTokens(packedContext),
      ...stubResponse("falha", "Não foi possível empacotar: budget ou fontes insuficientes."),
    };
  }

  let retrieveHandle: string | undefined;
  let reversibility: ReadStoredPackHandleResult["reversibility"] = sourceReversibility;
  const isMemoryOnlyPack = sources.every((source) => source.startsWith("memory:") || source.startsWith("note:") || source.startsWith("mh_"));
  // Handle quando há perda de budget OU truncamento de snippet por caps do style.
  if (hadMaterialLoss || hadSnippetTruncation || isMemoryOnlyPack) {
    const handlePrefix = isMemoryOnlyPack
      ? "mh"
      : "rh";
    retrieveHandle = `${handlePrefix}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const storedReversibility = writeStoredPackHandle(cwd, {
      handle: retrieveHandle,
      created_at: new Date().toISOString(),
      goal,
      style,
      token_budget: tokenBudget,
      manifest_hash: envelope.structuralIndex?.manifest_hash ?? null,
      schema_version: envelope.schema_version,
      segments,
    });
    reversibility = compareReversibility(reversibility, storedReversibility);
    for (const item of removedOrSummarized) {
      item.recoverable = storedReversibility !== "none";
      item.via_handle = storedReversibility !== "none" ? retrieveHandle : undefined;
    }
    if (storedReversibility === "none") {
      limitations.add("Compressão irreversível: storage do retrieve_handle indisponível ou incompleto.");
    } else if (hadMaterialLoss) {
      limitations.add(
        "token_budget excedido; essencial preservado; ver removed_or_summarized e reutilize retrieve_handle em sources[].",
      );
    } else if (hadSnippetTruncation && !hadMaterialLoss) {
      limitations.add(
        "Snippet(s) truncados pelos caps do style; use retrieve com context_lines ou style=deep.",
      );
    }
  }

  if (!hadMaterialLoss && reversibility === "full") {
    reversibility = sourceReversibility;
  }

  const state =
    envelope.state === "stale"
      ? "stale"
      : hadMaterialLoss || hadSnippetTruncation || limitations.size > 0
        ? "parcial"
        : "sucesso";

  return {
    packed_context: packedContext,
    origin_refs: uniqueOriginRefs(originRefs),
    removed_or_summarized: removedOrSummarized,
    retrieve_handle: retrieveHandle,
    reversibility,
    token_estimate: countTokens(packedContext),
    ...stubResponse(state, "Contexto comprimido pronto para o modelo.", {
      limitations: Array.from(limitations),
      staleness_hint: envelope.staleness_hint,
    }),
  };
}
