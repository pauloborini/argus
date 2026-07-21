// Tool `explore`: contexto composto (callers/callees/snippets) via SQL lazy.
import { stubResponse } from "../../contracts/response-state.js";
import type { ExtractedSymbol, FileStructuralEntry } from "../../extraction/types.js";
import type { Database } from "../../storage/sqlite-db.js";
import {
  closeIndexDb,
  openIndexDb,
  readEdgesByTargetName,
  readFileEntryByPath,
  readFilePathMatches,
  readImportersMap,
  searchFtsInternal,
} from "../../storage/sqlite-index-store.js";
import { getIndexDbPath, readWorkspaceMetadata } from "../../workspace/workspace.js";
import { existsSync } from "node:fs";
import { VaultEngine } from "../../memory/vault-engine.js";
import { getMemoryDbPath } from "../../memory/paths.js";
import { openMemoryDb, closeMemoryDb } from "../../memory/storage/sqlite-db.js";
import { queryMemoryGraphForExplore } from "../../memory/memory-graph-query.js";
import { WORKSPACE_MISSING, uniqueByKey, fileMatchesTests } from "./common.js";
import type {
  ToolResponsePayload,
  ExploreArgs,
  IndexEnvelope,
  ExploreRef,
  PackSegment,
} from "./common.js";
import {
  buildActionableSnippet,
  formatSnippetBlock,
  readFullSymbolBody,
  readSymbolSignature,
  type BuiltSnippet,
} from "./snippet-builder.js";
import {
  createRetrieveHandleId,
  writeStoredPackHandle,
} from "./retrieve-handle-store.js";

function buildSnippetRefs(
  cwd: string,
  entry: FileStructuralEntry,
  symbols: ExtractedSymbol[],
  limit: number,
): BuiltSnippet[] {
  // Explore default = balanced acionável (trecho verbatim + signature).
  return symbols.slice(0, limit).map((symbol) =>
    buildActionableSnippet(
      cwd,
      entry.relative_path,
      symbol.start_line,
      symbol.end_line,
      symbol.name,
      "balanced",
    ),
  );
}

function collectFileRelevantFiles(
  db: Database,
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

  // Scan leve de imports_json (sem symbols/edges) — não é full-load estrutural.
  const importers = readImportersMap(db).get(entry.relative_path) ?? [];
  for (const importerPath of importers) {
    if (!includeTests && fileMatchesTests(importerPath)) {
      continue;
    }
    refs.push({
      path: importerPath,
      reason: "importer_file",
    });
  }

  return uniqueByKey(refs, (item) => `${item.path}:${item.reason ?? ""}`).slice(0, budget);
}

function collectCallersAndCallees(
  db: Database,
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
    for (const row of readEdgesByTargetName(db, targetName)) {
      if (row.kind !== "calls") {
        continue;
      }
      if (!includeTests && fileMatchesTests(row.relative_path)) {
        continue;
      }
      callers.push({
        name: targetName,
        path: row.relative_path,
        kind: "calls",
        reason:
          row.relative_path === entry.relative_path
            ? "same_file_call_match"
            : "cross_file_call_match",
      });
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
  db: Database,
  target: string,
  includeTests: boolean,
): { entry: FileStructuralEntry | null; candidates: ExploreRef[] } {
  const normalized = target.trim().toLowerCase();
  const matches = readFilePathMatches(db, normalized);
  const exactPaths = matches.exact.filter(
    (path) => includeTests || !fileMatchesTests(path),
  );
  if (exactPaths.length === 1) {
    return { entry: readFileEntryByPath(db, exactPaths[0]!), candidates: [] };
  }
  const partialPaths = matches.partial.filter(
    (path) => includeTests || !fileMatchesTests(path),
  );
  if (partialPaths.length === 1) {
    return { entry: readFileEntryByPath(db, partialPaths[0]!), candidates: [] };
  }
  return {
    entry: null,
    candidates: partialPaths.slice(0, 10).map((path) => ({
      path,
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

function findMemoryRefs(
  cwd: string,
  target: string,
  mode: ExploreArgs["mode"],
  entryPath?: string,
): Array<{
  path: string;
  title: string;
  score: number;
  reason: string;
  mechanism?: string;
  confidence?: string;
  evidence?: string;
  source_note_id?: string;
}> {
  const graphRefs: Array<{
    path: string;
    title: string;
    score: number;
    reason: string;
    mechanism?: string;
    confidence?: string;
    evidence?: string;
    source_note_id?: string;
  }> = [];

  if (existsSync(getMemoryDbPath(cwd))) {
    try {
      const db = openMemoryDb(cwd, { readonly: true });
      try {
        const refs = queryMemoryGraphForExplore(db, mode ?? "topic", target, entryPath, 5);
        for (const ref of refs) {
          graphRefs.push({
            path: ref.path,
            title: ref.title,
            score: ref.score,
            reason: ref.reason,
            mechanism: ref.mechanism,
            confidence: ref.confidence,
            evidence: ref.evidence,
            source_note_id: ref.source_note_id,
          });
        }
      } finally {
        closeMemoryDb(db);
      }
    } catch {
      // degrade to FTS
    }
  }

  if (graphRefs.length > 0) {
    return graphRefs;
  }

  try {
    const query = mode === "file" && entryPath ? `${entryPath} ${target}` : target;
    const result = VaultEngine.search(query, { limit: 5, includeSnippets: true }, cwd);
    const chunks =
      (result.chunks as Array<{
        path: string;
        title: string;
        score: number;
        mechanism?: string;
        confidence?: string;
        stale_reason?: string;
        contradiction_reason?: string;
        note_id?: string;
      }> | undefined) ?? [];
    return chunks.map((chunk) => ({
      path: chunk.path,
      title: chunk.title,
      score: chunk.score,
      reason: mode === "file" ? "path_or_tag_overlap" : mode === "symbol" ? "symbol_mention" : "topic_match",
      mechanism: chunk.mechanism ?? "fts-only",
      confidence: chunk.confidence,
      evidence: chunk.stale_reason ?? chunk.contradiction_reason,
      source_note_id: chunk.note_id,
    }));
  } catch {
    return [];
  }
}

export function buildExploreResponse(
  cwd: string,
  envelope: IndexEnvelope,
  args?: ExploreArgs,
): ToolResponsePayload {
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

  if (envelope.state === "falha" || !envelope.structuralIndex) {
    return {
      summary: "",
      central_symbols: [],
      relevant_files: [],
      imports: [],
      callers: [],
      callees: [],
      snippets: [],
      suggested_next_action: "",
      ...stubResponse(envelope.state, envelope.message, {
        limitations: envelope.limitations,
        staleness_hint: envelope.staleness_hint,
      }),
    };
  }

  const index = envelope.structuralIndex;
  const includeTests = args?.include_tests ?? false;
  const budget = Math.max(1, Math.min(args?.budget ?? 6, 20));
  const mode = args?.mode ?? "symbol";
  let entry: FileStructuralEntry | null = null;
  let targetSymbol: ExtractedSymbol | null = null;
  let ambiguityCandidates: ExploreRef[] = [];

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
    if (mode === "file") {
      const selection = selectFileTarget(db, target, includeTests);
      entry = selection.entry;
      ambiguityCandidates = selection.candidates;
    } else {
      const hits = searchFtsInternal(db, target, budget);
      const exactHits = hits.filter((hit) => hit.name.toLowerCase() === target.toLowerCase());
      if (mode === "topic") {
        const topicFiles: FileStructuralEntry[] = [];
        for (const hit of hits) {
          const file = readFileEntryByPath(db, hit.relative_path);
          if (file) {
            topicFiles.push(file);
          }
        }
        const uniqueFiles = uniqueByKey(topicFiles, (file) => file.relative_path);
        if (uniqueFiles.length === 1) {
          entry = uniqueFiles[0]!;
        } else {
          ambiguityCandidates = uniqueFiles.slice(0, 10).map((file) => ({
            path: file.relative_path,
            reason: "topic_match",
          }));
        }
      } else if (exactHits.length === 1) {
        const hit = exactHits[0]!;
        entry = readFileEntryByPath(db, hit.relative_path);
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
        entry = readFileEntryByPath(db, hit.relative_path);
        targetSymbol = entry?.symbols.find((symbol) => symbol.name === hit.name) ?? null;
      } else if (hits.length > 1) {
        ambiguityCandidates = hits.slice(0, 10).map((hit) => ({
          name: hit.name,
          path: hit.relative_path,
          kind: hit.kind,
          reason: "fts_candidate",
        }));
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
            ? "Refine a query com path, nome exato ou use `argus search` para desambiguar."
            : "Use `argus search` ou `argus files` para localizar um alvo indexado válido.",
        candidates: ambiguityCandidates,
        ...stubResponse(
          state,
          ambiguityCandidates.length > 1
            ? "Múltiplos alvos possíveis para explore; refine o target."
            : "E_INSUFFICIENT_EVIDENCE: Alvo não resolvido no índice atual.",
          {
            limitations:
              state === "ambigua"
                ? ["Explore v1 exige um alvo resolvido de forma suficientemente específica."]
                : undefined,
            staleness_hint: envelope.staleness_hint,
          },
        ),
      };
    }

    const centralSymbolPool = targetSymbol
      ? [targetSymbol, ...entry.symbols.filter((symbol) => symbol.name !== targetSymbol!.name)]
      : entry.symbols;
    const centralSymbols = centralSymbolPool.slice(0, Math.max(1, Math.min(args?.depth ?? 3, 5)));
    const relevantFiles = collectFileRelevantFiles(db, entry, includeTests, budget);
    const imports = entry.imports.slice(0, budget);
    const { callers, callees } = collectCallersAndCallees(db, entry, targetSymbol, includeTests, budget);
    const snippets = buildSnippetRefs(cwd, entry, centralSymbols, budget);

    const partialCoverage = index.coverage_by_language[entry.language]?.coverage_level === "partial";
    const state =
      envelope.state === "stale"
        ? "stale"
        : partialCoverage || mode === "topic"
          ? "parcial"
          : "sucesso";
    const limitations = [
      ...(envelope.limitations ?? []),
      ...(partialCoverage
        ? [`Cobertura ${entry.language} é parcial para explore v1; callers/callees podem estar incompletos.`]
        : []),
      ...(targetSymbol
        ? ["Chamadas sem import resolvido podem degradar para correspondência global por nome."]
        : ["Exploração de arquivo combina símbolos, imports e relações estruturais indexadas."]),
    ];

    const targetLabel = targetSymbol ? `Símbolo ${targetSymbol.name}` : `Arquivo ${entry.relative_path}`;
    const memoryRefs = findMemoryRefs(cwd, target, mode, entry.relative_path);

    const truncatedSnippets = snippets.filter((snippet) => snippet.truncated === true);
    let retrieveHandle: string | undefined;
    if (truncatedSnippets.length > 0) {
      const segments: PackSegment[] = [];
      for (const snippet of truncatedSnippets) {
        const fullBody =
          readFullSymbolBody(cwd, snippet.path, snippet.start_line, snippet.end_line) ??
          snippet.body ??
          "";
        if (!fullBody.trim()) {
          continue;
        }
        const recoverable = {
          ...snippet,
          body: fullBody,
          truncated: false,
        };
        segments.push({
          ref: snippet.symbol ?? snippet.path,
          text: formatSnippetBlock(recoverable, "deep"),
          originRefs: [
            {
              ref: target,
              path: snippet.path,
              start_line: snippet.start_line,
              end_line: snippet.end_line,
              symbol: snippet.symbol,
            },
          ],
        });
      }

      if (segments.length > 0) {
        retrieveHandle = createRetrieveHandleId("rh");
        const stored = writeStoredPackHandle(cwd, {
          handle: retrieveHandle,
          created_at: new Date().toISOString(),
          goal: `explore:${target}`,
          style: "balanced",
          token_budget: 0,
          manifest_hash: index.manifest_hash ?? null,
          schema_version: envelope.schema_version,
          segments,
        });
        if (stored === "none") {
          retrieveHandle = undefined;
          limitations.push(
            "Truncamento detectado, mas storage do retrieve_handle ficou indisponível.",
          );
        } else {
          limitations.push(
            "Snippet(s) truncados pelos caps balanced; use retrieve com o retrieve_handle para o corpo completo.",
          );
        }
      }
    }

    const exploreState =
      retrieveHandle && state === "sucesso" ? "parcial" : state;

    const suggestedNextAction = retrieveHandle
      ? `Use \`retrieve\` com handle ${retrieveHandle} para reidratar o corpo completo, ou \`pack_context\` para empacotar fontes.`
      : "Use `pack_context` para empacotar este alvo e fontes relacionadas sob budget.";

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
        signature:
          readSymbolSignature(cwd, entry!.relative_path, symbol.start_line, symbol.end_line) ??
          undefined,
      })),
      relevant_files: relevantFiles,
      imports,
      callers,
      callees,
      snippets,
      memory_refs: memoryRefs,
      ...(retrieveHandle ? { retrieve_handle: retrieveHandle } : {}),
      suggested_next_action: suggestedNextAction,
      ...stubResponse(exploreState, "Exploração estrutural composta concluída.", {
        limitations,
        staleness_hint: envelope.staleness_hint,
      }),
    };
  } finally {
    closeIndexDb(db);
  }
}
