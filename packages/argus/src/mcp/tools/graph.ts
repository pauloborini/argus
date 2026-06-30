// Engine de grafo trace/impact: resolução, adjacência/BFS lazy, PageRank.
import type { StructuralIndex, ExtractedSymbol, FileStructuralEntry } from "../../extraction/types.js";
import { countEdgesByTargetName, readEdgesByRawTarget, readEdgesByTargetName, readFileEntryByPath, readFilePathMatches, readImportersMap, readSymbolFilePathsByName, searchFtsInternal } from "../../storage/sqlite-index-store.js";
import type { Database } from "../../storage/sqlite-db.js";
import { uniqueByKey, fileMatchesTests } from "./common.js";
import type { ExploreRef, TraceResolvedTarget, TraceNode, TraceEdgeStep, TracePathPayload, TraceUncertaintyPoint } from "./common.js";

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

type SymbolMatch = { entry: FileStructuralEntry; symbol: ExtractedSymbol };

type SymbolNameIndex = Map<string, SymbolMatch[]>;

/**
 * Índice name→ocorrências construído **uma vez** por travessia. Antes,
 * `findFilesBySymbolName` varria index.files×símbolos a cada call-edge resolvida
 * (O(edges×arquivos×símbolos)); com o índice, cada resolução é O(1) e a
 * construção é O(arquivos×símbolos) uma só vez. Mesma ordem (arquivo→símbolo) e
 * mesmo filtro de testes do scan anterior.
 */
function buildSymbolNameIndex(index: StructuralIndex, includeTests: boolean): SymbolNameIndex {
  const map: SymbolNameIndex = new Map();
  for (const entry of index.files) {
    if (!includeTests && fileMatchesTests(entry.relative_path)) {
      continue;
    }
    for (const symbol of entry.symbols) {
      const list = map.get(symbol.name);
      if (list) {
        list.push({ entry, symbol });
      } else {
        map.set(symbol.name, [{ entry, symbol }]);
      }
    }
  }
  return map;
}

function findFilesBySymbolName(symbolIndex: SymbolNameIndex, symbolName: string): SymbolMatch[] {
  return symbolIndex.get(symbolName) ?? [];
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
  lookupByName: (name: string) => SymbolMatch[],
  source: FileStructuralEntry,
  rawTarget: string,
): {
  matches: SymbolMatch[];
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
  const imported = lookupByName(target).filter((match) =>
    importedPaths.has(match.entry.relative_path),
  );
  if (imported.length > 0) {
    return { matches: imported, resolution: "import" };
  }

  const global = lookupByName(target);
  return {
    matches: global,
    resolution: global.length > 0 ? "global" : "unresolved",
  };
}

/** Seleção de alvo de arquivo via SQL (exato + parcial), sem materializar index.files. */
function selectFileTargetLazy(
  graph: LazyTraceGraph,
  db: Database,
  target: string,
  includeTests: boolean,
): { entry: FileStructuralEntry | null; candidates: ExploreRef[] } {
  const normalized = target.trim().toLowerCase();
  const keep = (path: string): boolean => includeTests || !fileMatchesTests(path);
  const { exact, partial } = readFilePathMatches(db, normalized);
  const exactFiltered = exact.filter(keep);
  if (exactFiltered.length === 1) {
    return { entry: graph.fileEntry(exactFiltered[0]!), candidates: [] };
  }
  const partialFiltered = partial.filter(keep).sort((a, b) => a.localeCompare(b));
  return {
    entry: partialFiltered.length === 1 ? graph.fileEntry(partialFiltered[0]!) : null,
    candidates: partialFiltered.slice(0, 10).map((path) => ({ path, reason: "file_match" })),
  };
}

export function resolveTraceTarget(
  graph: LazyTraceGraph,
  db: Database,
  target: string,
  includeTests = false,
): TraceResolvedTarget | null {
  const normalized = target.trim();
  if (!normalized) {
    return null;
  }

  const fileSelection = selectFileTargetLazy(graph, db, normalized, includeTests);
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

  const hits = searchFtsInternal(db, normalized, 20);
  const exactHits = hits.filter((hit) => hit.name.toLowerCase() === normalized.toLowerCase());
  const resolveHit = (hit: { relative_path: string; name: string }): { entry: FileStructuralEntry; symbol: ExtractedSymbol } | null => {
    const entry = graph.fileEntry(hit.relative_path);
    const symbol = entry?.symbols.find((item) => item.name === hit.name);
    return entry && symbol ? { entry, symbol } : null;
  };
  if (exactHits.length === 1) {
    const resolved = resolveHit(exactHits[0]!);
    if (resolved) {
      return { node: buildSymbolNode(resolved.entry, resolved.symbol), candidates: [] };
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
    const resolved = resolveHit(hits[0]!);
    if (resolved) {
      return {
        node: buildSymbolNode(resolved.entry, resolved.symbol),
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

  return null;
}

export function buildTraceAdjacency(
  index: StructuralIndex,
  includeTests: boolean,
): Map<string, TraceEdgeStep[]> {
  const adjacency = new Map<string, TraceEdgeStep[]>();
  const addEdge = (edge: TraceEdgeStep): void => {
    const current = adjacency.get(edge.from.id) ?? [];
    current.push(edge);
    adjacency.set(edge.from.id, current);
  };

  // Índice name→ocorrências construído uma vez: elimina o scan O(arquivos×
  // símbolos) que ocorria por call-edge/herança resolvida.
  const symbolIndex = buildSymbolNameIndex(index, includeTests);
  const referenceCounts = new Map<string, number>();
  for (const entry of index.files) {
    if (!includeTests && fileMatchesTests(entry.relative_path)) {
      continue;
    }
    for (const edge of entry.edges) {
      if (edge.kind === "calls" || edge.kind === "extends" || edge.kind === "implements") {
        const target = callTargetName(edge.to);
        referenceCounts.set(target, (referenceCounts.get(target) ?? 0) + 1);
      }
    }
  }
  const symbolWeight = (name: string): number => {
    const definitionCount = findFilesBySymbolName(symbolIndex, name).length;
    const referenceCount = referenceCounts.get(name) ?? 1;
    const descriptiveNameBoost = name.length >= 8 ? 10 : 1;
    const privatePenalty = name.startsWith("_") ? 0.1 : 1;
    const commonNamePenalty = definitionCount > 5 ? 0.1 : 1;
    return Math.max(
      0.001,
      descriptiveNameBoost * privatePenalty * commonNamePenalty * Math.sqrt(referenceCount),
    );
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
        const resolved = resolveCallTargets((name) => findFilesBySymbolName(symbolIndex, name), entry, edge.to);
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
            weight: symbolWeight(targetNode.name),
          });
          addEdge({
            relation: "called_by",
            from: targetNode,
            to: callerNode,
            line: edge.line,
            uncertain,
            weight: symbolWeight(targetNode.name),
          });
        }
      }

      if (edge.kind === "extends" || edge.kind === "implements") {
        const originSymbol = entry.symbols.find((symbol) => symbol.name === edge.from_symbol);
        if (!originSymbol) {
          continue;
        }
        const originNode = buildSymbolNode(entry, originSymbol);
        const targetMatches = findFilesBySymbolName(symbolIndex, edge.to);
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
            weight: symbolWeight(targetNode.name),
          });
          addEdge({
            relation: `${edge.kind}_by`,
            from: targetNode,
            to: originNode,
            line: edge.line,
            uncertain,
            weight: symbolWeight(targetNode.name),
          });
        }
      }
    }
  }

  return adjacency;
}

/**
 * PageRank **personalizado** sobre a adjacency de trace. O vetor de
 * teleporte concentra massa nos `seeds` (o alvo da query), então o score
 * mede centralidade *relativa ao ponto de partida*: nós estruturalmente
 * próximos do seed E bem conectados pontuam alto. Usado para ordenar o
 * blast radius do impact antes do corte — o slice passa a preservar os nós
 * mais centrais em vez da ordem arbitrária de descoberta do BFS.
 *
 * Grafo quase-simétrico (toda relação tem inversa: calls/called_by,
 * imports/imported_by, declares/defined_in), então o PR converge para uma
 * centralidade de proximidade ponderada. Iteração de potência com damping
 * 0.85, massa dangling redistribuída pelo vetor de personalização.
 */
export function personalizedPageRank(
  adjacency: Map<string, TraceEdgeStep[]>,
  seeds: string[],
  options?: { damping?: number; iterations?: number; tolerance?: number },
): Map<string, number> {
  const damping = options?.damping ?? 0.85;
  const maxIterations = options?.iterations ?? 30;
  const tolerance = options?.tolerance ?? 1e-6;

  // Conjunto de nós = união de origens (chaves) e destinos de cada aresta.
  const nodeIds = new Set<string>();
  const outNeighbors = new Map<string, Array<{ id: string; weight: number }>>();
  for (const [from, edges] of adjacency) {
    nodeIds.add(from);
    const targets = outNeighbors.get(from) ?? [];
    for (const edge of edges) {
      nodeIds.add(edge.to.id);
      const weight = edge.weight;
      targets.push({
        id: edge.to.id,
        weight: weight !== undefined && Number.isFinite(weight) && weight > 0 ? weight : 1,
      });
    }
    outNeighbors.set(from, targets);
  }

  if (nodeIds.size === 0) {
    return new Map();
  }

  // Personalização: massa uniforme nos seeds presentes no grafo; se nenhum
  // seed pertence ao grafo, cai para teleporte uniforme (PR global).
  const seedSet = seeds.filter((id) => nodeIds.has(id));
  const personalization = new Map<string, number>();
  if (seedSet.length > 0) {
    const mass = 1 / seedSet.length;
    for (const id of seedSet) {
      personalization.set(id, mass);
    }
  } else {
    const mass = 1 / nodeIds.size;
    for (const id of nodeIds) {
      personalization.set(id, mass);
    }
  }

  let pr = new Map<string, number>();
  for (const id of nodeIds) {
    pr.set(id, personalization.get(id) ?? 0);
  }

  for (let iter = 0; iter < maxIterations; iter += 1) {
    const next = new Map<string, number>();
    // Massa dangling (nós sem saída) redistribuída pela personalização.
    let danglingMass = 0;
    for (const id of nodeIds) {
      const out = outNeighbors.get(id);
      if (!out || out.length === 0) {
        danglingMass += pr.get(id) ?? 0;
      }
    }
    for (const id of nodeIds) {
      const teleport = (1 - damping) * (personalization.get(id) ?? 0);
      const dangling = damping * danglingMass * (personalization.get(id) ?? 0);
      next.set(id, teleport + dangling);
    }
    for (const [id, out] of outNeighbors) {
      if (out.length === 0) {
        continue;
      }
      const totalWeight = out.reduce((sum, target) => sum + target.weight, 0);
      if (totalWeight === 0) {
        continue;
      }
      for (const target of out) {
        const share = damping * (pr.get(id) ?? 0) * (target.weight / totalWeight);
        next.set(target.id, (next.get(target.id) ?? 0) + share);
      }
    }

    let delta = 0;
    for (const id of nodeIds) {
      delta += Math.abs((next.get(id) ?? 0) - (pr.get(id) ?? 0));
    }
    pr = next;
    if (delta < tolerance) {
      break;
    }
  }

  return pr;
}

/** Tupla intermediária de resolução de uma call-edge (paridade com buildTraceAdjacency). */
interface ResolvedCall {
  callerNode: TraceNode;
  targetNode: TraceNode;
  uncertain?: string;
}

/**
 * Provê `outEdges(node)` para um nó **sem** materializar o grafo inteiro:
 * expande as arestas sob demanda via SQL indexado (idx_edges_target_name /
 * idx_symbols_name + scan único de imports). Cada nó é expandido no máximo uma
 * vez (`expanded`); o subgrafo descoberto fica em `discovered` para o PageRank
 * rodar só sobre o que o BFS visitou. Resolução (local/import/global), pesos e
 * razões de incerteza idênticos ao caminho eager — muda só a fonte de dados.
 */
export class LazyTraceGraph {
  private readonly fileCache = new Map<string, FileStructuralEntry | null>();
  private readonly symbolMatchCache = new Map<string, SymbolMatch[]>();
  private readonly refCountCache = new Map<string, number>();
  private readonly expanded = new Map<string, TraceEdgeStep[]>();
  readonly discovered = new Map<string, TraceEdgeStep[]>();
  private importers: Map<string, string[]> | null = null;

  constructor(
    private readonly db: Database,
    private readonly includeTests: boolean,
  ) {}

  private includeFile(path: string): boolean {
    return this.includeTests || !fileMatchesTests(path);
  }

  fileEntry(path: string): FileStructuralEntry | null {
    if (this.fileCache.has(path)) {
      return this.fileCache.get(path) ?? null;
    }
    const entry = readFileEntryByPath(this.db, path);
    this.fileCache.set(path, entry);
    return entry;
  }

  languageOf(path: string): string | null {
    return this.fileEntry(path)?.language ?? null;
  }

  private matchesByName(name: string): SymbolMatch[] {
    const cached = this.symbolMatchCache.get(name);
    if (cached) {
      return cached;
    }
    const matches: SymbolMatch[] = [];
    for (const path of readSymbolFilePathsByName(this.db, name)) {
      if (!this.includeFile(path)) {
        continue;
      }
      const entry = this.fileEntry(path);
      if (!entry) {
        continue;
      }
      for (const symbol of entry.symbols) {
        if (symbol.name === name) {
          matches.push({ entry, symbol });
        }
      }
    }
    this.symbolMatchCache.set(name, matches);
    return matches;
  }

  private referenceCount(name: string): number {
    let value = this.refCountCache.get(name);
    if (value === undefined) {
      value = countEdgesByTargetName(this.db, name);
      this.refCountCache.set(name, value);
    }
    return value;
  }

  private weight(name: string): number {
    const definitionCount = this.matchesByName(name).length;
    const referenceCount = this.referenceCount(name) || 1;
    const descriptiveNameBoost = name.length >= 8 ? 10 : 1;
    const privatePenalty = name.startsWith("_") ? 0.1 : 1;
    const commonNamePenalty = definitionCount > 5 ? 0.1 : 1;
    return Math.max(
      0.001,
      descriptiveNameBoost * privatePenalty * commonNamePenalty * Math.sqrt(referenceCount),
    );
  }

  private importersOf(path: string): string[] {
    if (!this.importers) {
      this.importers = readImportersMap(this.db);
    }
    return this.importers.get(path) ?? [];
  }

  /** Resolve uma call-edge de um arquivo-fonte → tuplas caller/target (igual ao eager). */
  private resolveCalls(source: FileStructuralEntry, edge: { from_symbol?: string; to: string; line?: number }): ResolvedCall[] {
    const resolved = resolveCallTargets((name) => this.matchesByName(name), source, edge.to);
    const caller = edge.from_symbol
      ? source.symbols.find((symbol) => symbol.name === edge.from_symbol) ?? null
      : findOwningSymbol(source, edge.line);
    const callerNode = caller ? buildSymbolNode(source, caller) : buildFileNode(source);
    return resolved.matches.map((match) => {
      const targetNode = buildSymbolNode(match.entry, match.symbol);
      const uncertain =
        resolved.resolution === "global"
          ? "Alvo resolvido globalmente por nome; não há import compatível comprovando o vínculo."
          : resolved.matches.length > 1
            ? "Mais de um alvo compatível permanece após resolução por import."
            : caller
              ? undefined
              : "Símbolo chamador não identificado; chamada atribuída ao arquivo.";
      return { callerNode, targetNode, uncertain };
    });
  }

  /** Out-edges de um nó (forward + reverse), expandido no máximo uma vez. */
  outEdges(node: TraceNode): TraceEdgeStep[] {
    const cached = this.expanded.get(node.id);
    if (cached) {
      return cached;
    }
    const edges = node.node_type === "file" ? this.expandFile(node) : this.expandSymbol(node);
    this.expanded.set(node.id, edges);
    this.discovered.set(node.id, edges);
    return edges;
  }

  private expandFile(node: TraceNode): TraceEdgeStep[] {
    const entry = this.fileEntry(node.path);
    if (!entry || !this.includeFile(node.path)) {
      return [];
    }
    const fileNode = buildFileNode(entry);
    const edges: TraceEdgeStep[] = [];

    for (const symbol of entry.symbols) {
      edges.push({ relation: "declares", from: fileNode, to: buildSymbolNode(entry, symbol), line: symbol.start_line });
    }

    for (const imported of entry.imports) {
      if (!imported.resolved_path || !this.includeFile(imported.resolved_path)) {
        continue;
      }
      const targetEntry = this.fileEntry(imported.resolved_path);
      if (!targetEntry) {
        continue;
      }
      edges.push({ relation: "imports", from: fileNode, to: buildFileNode(targetEntry) });
    }

    for (const importerPath of this.importersOf(node.path)) {
      if (!this.includeFile(importerPath)) {
        continue;
      }
      const importerEntry = this.fileEntry(importerPath);
      if (!importerEntry) {
        continue;
      }
      edges.push({ relation: "imported_by", from: fileNode, to: buildFileNode(importerEntry) });
    }

    // Calls cujo chamador não foi identificado: o eager atribui a aresta ao
    // arquivo (callerNode = fileNode). Só essas saem do nó-arquivo.
    for (const edge of entry.edges) {
      if (edge.kind !== "calls") {
        continue;
      }
      for (const call of this.resolveCalls(entry, edge)) {
        if (call.callerNode.id !== fileNode.id) {
          continue;
        }
        edges.push({
          relation: "calls",
          from: fileNode,
          to: call.targetNode,
          line: edge.line,
          uncertain: call.uncertain,
          weight: this.weight(call.targetNode.name),
        });
      }
    }

    return edges;
  }

  private expandSymbol(node: TraceNode): TraceEdgeStep[] {
    const entry = this.fileEntry(node.path);
    const edges: TraceEdgeStep[] = [];
    if (entry) {
      edges.push({ relation: "defined_in", from: node, to: buildFileNode(entry), line: node.line });

      // Forward: calls/extends/implements de cujo dono é este símbolo.
      for (const edge of entry.edges) {
        if (edge.kind === "calls") {
          if (edge.source === "scip") {
            const caller = edge.from_symbol
              ? entry.symbols.find((s) => s.name === edge.from_symbol) ?? null
              : null;
            const callerNode = caller ? buildSymbolNode(entry, caller) : buildFileNode(entry);
            if (callerNode.id !== node.id) continue;
            const targetName = callTargetName(edge.to);
            const targetMatches = this.matchesByName(targetName);
            for (const match of targetMatches) {
              edges.push({
                relation: "calls",
                from: node,
                to: buildSymbolNode(match.entry, match.symbol),
                line: edge.line,
                weight: this.weight(match.symbol.name),
              });
            }
            continue;
          }
          for (const call of this.resolveCalls(entry, edge)) {
            if (call.callerNode.id !== node.id) {
              continue;
            }
            edges.push({
              relation: "calls",
              from: node,
              to: call.targetNode,
              line: edge.line,
              uncertain: call.uncertain,
              weight: this.weight(call.targetNode.name),
            });
          }
        } else if ((edge.kind === "extends" || edge.kind === "implements") && edge.from_symbol) {
          const originSymbol = entry.symbols.find((symbol) => symbol.name === edge.from_symbol);
          if (!originSymbol || buildSymbolNode(entry, originSymbol).id !== node.id) {
            continue;
          }
          if (edge.source === "scip") {
            const targetName = callTargetName(edge.to);
            const targetMatches = this.matchesByName(targetName);
            for (const match of targetMatches) {
              edges.push({
                relation: edge.kind,
                from: node,
                to: buildSymbolNode(match.entry, match.symbol),
                line: edge.line,
                weight: this.weight(match.symbol.name),
              });
            }
            continue;
          }
          const targetMatches = this.matchesByName(edge.to);
          for (const match of targetMatches) {
            edges.push({
              relation: edge.kind,
              from: node,
              to: buildSymbolNode(match.entry, match.symbol),
              line: edge.line,
              uncertain: targetMatches.length > 1 ? "Múltiplos símbolos com o mesmo nome podem representar este alvo." : undefined,
              weight: this.weight(match.symbol.name),
            });
          }
        }
      }
    }

    // Reverse called_by: quem chama este símbolo (candidatos por target_name).
    for (const row of readEdgesByTargetName(this.db, node.name)) {
      if (row.kind !== "calls" || !this.includeFile(row.relative_path)) {
        continue;
      }
      const source = this.fileEntry(row.relative_path);
      if (!source) {
        continue;
      }
      if (row.source === "scip") {
        const caller = row.from_symbol
          ? source.symbols.find((s) => s.name === row.from_symbol) ?? null
          : null;
        const callerNode = caller ? buildSymbolNode(source, caller) : buildFileNode(source);
        edges.push({
          relation: "called_by",
          from: node,
          to: callerNode,
          line: row.line ?? undefined,
          weight: this.weight(node.name),
        });
        continue;
      }
      for (const call of this.resolveCalls(source, { from_symbol: row.from_symbol ?? undefined, to: row.target, line: row.line ?? undefined })) {
        if (call.targetNode.id !== node.id) {
          continue;
        }
        edges.push({
          relation: "called_by",
          from: node,
          to: call.callerNode,
          line: row.line ?? undefined,
          uncertain: call.uncertain,
          weight: this.weight(node.name),
        });
      }
    }

    // Reverse extends_by/implements_by: quem herda deste símbolo (target cru == nome).
    for (const row of readEdgesByRawTarget(this.db, node.name)) {
      if ((row.kind !== "extends" && row.kind !== "implements") || !this.includeFile(row.relative_path) || !row.from_symbol) {
        continue;
      }
      const source = this.fileEntry(row.relative_path);
      const originSymbol = source?.symbols.find((symbol) => symbol.name === row.from_symbol);
      if (!source || !originSymbol) {
        continue;
      }
      if (row.source === "scip") {
        edges.push({
          relation: `${row.kind}_by`,
          from: node,
          to: buildSymbolNode(source, originSymbol),
          line: row.line ?? undefined,
          weight: this.weight(node.name),
        });
        continue;
      }
      const targetMatches = this.matchesByName(row.target);
      if (!targetMatches.some((match) => buildSymbolNode(match.entry, match.symbol).id === node.id)) {
        continue;
      }
      edges.push({
        relation: `${row.kind}_by`,
        from: node,
        to: buildSymbolNode(source, originSymbol),
        line: row.line ?? undefined,
        uncertain: targetMatches.length > 1 ? "Múltiplos símbolos com o mesmo nome podem representar este alvo." : undefined,
        weight: this.weight(node.name),
      });
    }

    return edges;
  }
}

export function bfsTracePath(
  outEdges: (node: TraceNode) => TraceEdgeStep[],
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
    const nextEdges = outEdges(current.node);
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

export function toTracePathPayload(path: TraceEdgeStep[]): TracePathPayload {
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

export function collectTraceUncertainty(
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
