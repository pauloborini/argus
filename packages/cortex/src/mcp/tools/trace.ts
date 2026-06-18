// Tool `trace`: caminho provável entre pontos via BFS no grafo lazy.
import { stubResponse } from "../../contracts/response-state.js";
import { closeIndexDb, openIndexDb } from "../../storage/sqlite-index-store.js";
import type { Database } from "../../storage/sqlite-db.js";
import { getIndexDbPath, readWorkspaceMetadata } from "../../workspace/workspace.js";
import { WORKSPACE_MISSING } from "./common.js";
import type { ToolResponsePayload, TraceArgs, IndexEnvelope, TraceNode, TraceEdgeStep } from "./common.js";
import { resolveTraceTarget, LazyTraceGraph, bfsTracePath, toTracePathPayload, collectTraceUncertainty } from "./graph.js";

export function buildTraceResponse(
  cwd: string,
  envelope: IndexEnvelope,
  args?: TraceArgs,
): ToolResponsePayload {
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

  if (envelope.state === "falha" || !envelope.structuralIndex) {
    return {
      paths: [],
      files: [],
      symbols: [],
      uncertainty_points: [],
      ...stubResponse(envelope.state, envelope.message, {
        limitations: envelope.limitations,
        staleness_hint: envelope.staleness_hint,
      }),
    };
  }

  const maxHops = Math.max(1, Math.min(args?.max_hops ?? 4, 6));
  const direction = args?.direction ?? "forward";
  const metadata = readWorkspaceMetadata(cwd);
  if (!metadata) {
    return {
      paths: [],
      files: [],
      symbols: [],
      uncertainty_points: [],
      ...stubResponse("falha", WORKSPACE_MISSING),
    };
  }
  const db = openIndexDb(getIndexDbPath(metadata.root_path), { readonly: true });
  try {
    return runTrace(db, envelope, { from, to: args?.to, direction, maxHops });
  } finally {
    closeIndexDb(db);
  }
}

export function runTrace(
  db: Database,
  envelope: IndexEnvelope,
  params: { from: string; to?: string; direction: "forward" | "backward" | "both"; maxHops: number },
): ToolResponsePayload {
  const { from, to, direction, maxHops } = params;
  const index = envelope.structuralIndex!;
  const graph = new LazyTraceGraph(db, false);
  const fromResolved = resolveTraceTarget(graph, db, from);
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

  const toResolved = to ? resolveTraceTarget(graph, db, to) : null;
  if (to && !toResolved) {
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

  const outEdges = (node: TraceNode): TraceEdgeStep[] => graph.outEdges(node);
  const fromNode = fromResolved.node!;
  const targetNode = toResolved?.node ?? null;
  let path =
    direction === "backward" && targetNode
      ? bfsTracePath(outEdges, targetNode, fromNode, maxHops)
      : bfsTracePath(outEdges, fromNode, targetNode, maxHops);

  if (!path && direction === "both" && targetNode) {
    path = bfsTracePath(outEdges, targetNode, fromNode, maxHops);
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
          staleness_hint: envelope.staleness_hint,
        },
      ),
    };
  }

  const payloadPath = toTracePathPayload(path);
  const pathFiles = payloadPath.files;
  const partialCoverage = pathFiles.some((relativePath) => {
    const language = graph.languageOf(relativePath);
    return language ? index.coverage_by_language[language]?.coverage_level === "partial" : false;
  });
  const uncertaintyPoints = collectTraceUncertainty(path, [
    ...(fromResolved.limitations ?? []),
    ...(toResolved?.limitations ?? []),
  ]);
  const state =
    envelope.state === "stale"
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
      staleness_hint: envelope.staleness_hint,
    }),
  };
}
