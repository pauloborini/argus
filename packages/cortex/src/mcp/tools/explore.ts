// Tool `explore`: contexto composto (callers/callees/snippets).
import { stubResponse } from "../../contracts/response-state.js";
import type { StructuralIndex, ExtractedSymbol, FileStructuralEntry } from "../../extraction/types.js";
import { closeIndexDb, openIndexDb, searchFtsInternal } from "../../storage/sqlite-index-store.js";
import { getIndexDbPath, readWorkspaceMetadata } from "../../workspace/workspace.js";
import { WORKSPACE_MISSING, uniqueByKey, fileMatchesTests } from "./common.js";
import type { ToolResponsePayload, ExploreArgs, IndexEnvelope, ExploreSnippetRef, ExploreRef } from "./common.js";
import { readSymbolSignature } from "./pack.js";

function buildSnippetRefs(
  cwd: string,
  entry: FileStructuralEntry,
  symbols: ExtractedSymbol[],
  limit: number,
): ExploreSnippetRef[] {
  return symbols.slice(0, limit).map((symbol) => ({
    path: entry.relative_path,
    start_line: symbol.start_line,
    end_line: symbol.end_line,
    symbol: symbol.name,
    signature:
      readSymbolSignature(cwd, entry.relative_path, symbol.start_line, symbol.end_line) ?? undefined,
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
          staleness_hint: envelope.staleness_hint,
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
      // Overview-first: forma do símbolo sem o corpo (body-on-demand via FS).
      signature:
        readSymbolSignature(cwd, entry!.relative_path, symbol.start_line, symbol.end_line) ??
        undefined,
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
      staleness_hint: envelope.staleness_hint,
    }),
  };
}
