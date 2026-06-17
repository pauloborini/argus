/** Tipos mínimos do schema SCIP (Sourcegraph Code Intelligence Protocol). */

export const enum SymbolRole {
  Definition = 1,
  Reference = 0,
}

export interface ScipRange {
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
}

export interface ScipOccurrence {
  range: ScipRange;
  symbol: string;
  symbolRoles: number;
}

export interface ScipDocument {
  relativePath: string;
  occurrences: ScipOccurrence[];
}

export interface ScipIndex {
  documents: ScipDocument[];
}

export interface ScipEdge {
  filePath: string;
  kind: "calls" | "references";
  fromSymbol: string;
  targetSymbol: string;
  line: number;
}
