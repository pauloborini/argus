/**
 * Mapeia occurrences SCIP → edges precisas do modelo Cortex.
 * Produz edges com source='scip' que sobrescrevem heurísticas tree-sitter.
 */
import type { Database } from "../storage/sqlite-db.js";
import type { ScipIndex } from "./types.js";
import { isDefinition, scipSymbolShortName } from "./parse-scip.js";

export interface ScipImportResult {
  edgesImported: number;
  filesMatched: number;
  filesMissing: number;
  symbolsCovered: number;
}

interface SymbolRow {
  id: number;
  file_id: number;
  name: string;
  start_line: number;
  end_line: number;
}

interface FileRow {
  id: number;
  relative_path: string;
}

/**
 * Importa edges SCIP para o índice SQLite existente.
 * - Casa paths SCIP com files.relative_path
 * - Referências dentro do range de um símbolo nosso → from_symbol
 * - Definições referidas → target resolvido por moniker
 * - Marca edges com source='scip'
 * - Remove edges heurísticas sobrepostas (mesmo from_symbol + target_name)
 */
export function importScipEdges(db: Database, scipIndex: ScipIndex): ScipImportResult {
  const result: ScipImportResult = { edgesImported: 0, filesMatched: 0, filesMissing: 0, symbolsCovered: 0 };

  const defsByMoniker = buildDefinitionIndex(scipIndex);

  const fileByPath = db.prepare(
    "SELECT id, relative_path FROM files WHERE relative_path = ?",
  );
  const symbolsByFileId = db.prepare(
    "SELECT id, file_id, name, start_line, end_line FROM symbols WHERE file_id = ? ORDER BY start_line",
  );
  const insertEdge = db.prepare(
    "INSERT INTO edges (file_id, kind, from_symbol, target, target_name, line, source) VALUES (?, ?, ?, ?, ?, ?, 'scip')",
  );
  const deleteOverlapping = db.prepare(
    "DELETE FROM edges WHERE file_id = ? AND from_symbol = ? AND target_name = ? AND source = 'heuristic'",
  );

  const coveredSymbols = new Set<number>();

  const tx = db.transaction(() => {
    for (const doc of scipIndex.documents) {
      const fileRow = fileByPath.get(doc.relativePath) as FileRow | undefined;
      if (!fileRow) {
        result.filesMissing++;
        continue;
      }
      result.filesMatched++;

      const symbols = symbolsByFileId.all(fileRow.id) as SymbolRow[];
      const refs = doc.occurrences.filter((occ) => !isDefinition(occ));

      for (const ref of refs) {
        const ownerSymbol = findOwningSymbol(symbols, ref.range.startLine);
        if (!ownerSymbol) continue;

        const targetDef = defsByMoniker.get(ref.symbol);
        if (!targetDef) continue;

        const targetName = scipSymbolShortName(ref.symbol);
        const targetPath = targetDef.relativePath;
        const target = targetPath ? `${targetPath}:${targetName}` : targetName;

        deleteOverlapping.run(fileRow.id, ownerSymbol.name, targetName);

        insertEdge.run(
          fileRow.id,
          "calls",
          ownerSymbol.name,
          target,
          targetName,
          ref.range.startLine + 1,
        );

        coveredSymbols.add(ownerSymbol.id);
        result.edgesImported++;
      }
    }
  });

  tx();
  result.symbolsCovered = coveredSymbols.size;
  return result;
}

interface DefLocation {
  relativePath: string;
  line: number;
}

function buildDefinitionIndex(scipIndex: ScipIndex): Map<string, DefLocation> {
  const map = new Map<string, DefLocation>();
  for (const doc of scipIndex.documents) {
    for (const occ of doc.occurrences) {
      if (isDefinition(occ)) {
        map.set(occ.symbol, { relativePath: doc.relativePath, line: occ.range.startLine });
      }
    }
  }
  return map;
}

function findOwningSymbol(symbols: SymbolRow[], line: number): SymbolRow | null {
  const oneBased = line + 1;
  let best: SymbolRow | null = null;
  let bestSpan = Infinity;
  for (const sym of symbols) {
    if (sym.start_line <= oneBased && sym.end_line >= oneBased) {
      const span = sym.end_line - sym.start_line;
      if (span < bestSpan) {
        best = sym;
        bestSpan = span;
      }
    }
  }
  return best;
}
