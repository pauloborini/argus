// Tool `impact`: blast radius + PageRank do subgrafo descoberto.
import { stubResponse } from "../../contracts/response-state.js";
import { closeIndexDb, openIndexDb } from "../../storage/sqlite-index-store.js";
import type { Database } from "../../storage/sqlite-db.js";
import { getIndexDbPath, readWorkspaceMetadata } from "../../workspace/workspace.js";
import { WORKSPACE_MISSING, uniqueByKey, fileMatchesTests } from "./common.js";
import type { ToolResponsePayload, ImpactArgs, IndexEnvelope, TraceNode, TraceUncertaintyPoint, ImpactRef } from "./common.js";
import { resolveTraceTarget, personalizedPageRank, LazyTraceGraph, collectTraceUncertainty } from "./graph.js";

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

export function buildImpactResponse(
  cwd: string,
  envelope: IndexEnvelope,
  args?: ImpactArgs,
): ToolResponsePayload {
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

  if (envelope.state === "falha" || !envelope.structuralIndex) {
    return {
      direct_affected: [],
      indirect_affected: [],
      files: [],
      tests: [],
      risk_summary: "",
      ...stubResponse(envelope.state, envelope.message, {
        limitations: envelope.limitations,
        staleness_hint: envelope.staleness_hint,
      }),
    };
  }

  const includeTests = args?.include_tests ?? false;
  const depthLimit = Math.max(1, Math.min(args?.depth ?? 3, 8));
  const direction = args?.direction ?? "both";
  const traceDirection = mapImpactDirectionToTrace(direction);
  const metadata = readWorkspaceMetadata(cwd);
  if (!metadata) {
    return {
      direct_affected: [],
      indirect_affected: [],
      files: [],
      tests: [],
      risk_summary: "",
      ...stubResponse("falha", WORKSPACE_MISSING),
    };
  }
  const db = openIndexDb(getIndexDbPath(metadata.root_path), { readonly: true });
  try {
    return runImpact(db, envelope, {
      target,
      includeTests,
      depthLimit,
      traceDirection,
      summaryOnly: args?.summary_only ?? false,
    });
  } finally {
    closeIndexDb(db);
  }
}

export function runImpact(
  db: Database,
  envelope: IndexEnvelope,
  params: {
    target: string;
    includeTests: boolean;
    depthLimit: number;
    traceDirection: "forward" | "backward" | "both";
    summaryOnly: boolean;
  },
): ToolResponsePayload {
  const index = envelope.structuralIndex!;
  const { target, includeTests, depthLimit, traceDirection, summaryOnly } = params;
  const graph = new LazyTraceGraph(db, includeTests);
  const resolved = resolveTraceTarget(graph, db, target, includeTests);

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

  const startNode = resolved.node!;
  const queue: Array<{ node: TraceNode; depth: number; via?: string }> = [{ node: startNode, depth: 0 }];
  const visited = new Set<string>([startNode.id]);
  const directAffected: Array<{ id: string; ref: ImpactRef }> = [];
  const indirectAffected: Array<{ id: string; ref: ImpactRef }> = [];
  const uncertaintyPoints: TraceUncertaintyPoint[] = [...collectTraceUncertainty([], resolved.limitations)];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.depth >= depthLimit) {
      continue;
    }
    const neighbors = graph.outEdges(current.node);
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
        directAffected.push({ id: edge.to.id, ref });
      } else {
        indirectAffected.push({ id: edge.to.id, ref });
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

  // PageRank personalizado no alvo: ordena o blast radius por centralidade
  // relativa ao seed antes do corte, então o slice preserva os afetados mais
  // estruturalmente relevantes em vez da ordem de descoberta do BFS. Empate
  // resolvido por profundidade (mais raso primeiro) e ordem de descoberta.
  const pageRank = personalizedPageRank(graph.discovered, [startNode.id]);
  const rankRefs = (items: Array<{ id: string; ref: ImpactRef }>): ImpactRef[] =>
    items
      .map((item, index) => ({ item, index, score: pageRank.get(item.id) ?? 0 }))
      .sort(
        (left, right) =>
          right.score - left.score ||
          left.item.ref.depth - right.item.ref.depth ||
          left.index - right.index,
      )
      .map((scored) => scored.item.ref);
  const directUnique = uniqueByKey(rankRefs(directAffected), (item) => `${item.node_type}:${item.path}:${item.name}`).slice(0, 50);
  const indirectUnique = uniqueByKey(rankRefs(indirectAffected), (item) => `${item.node_type}:${item.path}:${item.name}`).slice(0, 100);
  const allFiles = uniqueByKey(
    [startNode.path, ...directUnique.map((item) => item.path), ...indirectUnique.map((item) => item.path)],
    (item) => item,
  );
  const tests = allFiles.filter((path) => fileMatchesTests(path));
  const partialCoverage = allFiles.some((relativePath) => {
    const language = graph.languageOf(relativePath);
    return language ? index.coverage_by_language[language]?.coverage_level === "partial" : false;
  });
  const riskSummary = summarizeImpactRisk(
    directUnique.length,
    indirectUnique.length,
    uncertaintyPoints.length,
    tests.length,
  );
  const state =
    envelope.state === "stale"
      ? "stale"
      : partialCoverage || uncertaintyPoints.length > 0
        ? "parcial"
        : "sucesso";

  return {
    direct_affected: summaryOnly ? [] : directUnique,
    indirect_affected: summaryOnly ? [] : indirectUnique,
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
      staleness_hint: envelope.staleness_hint,
    }),
  };
}
