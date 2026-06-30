import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openIndexDb, closeIndexDb, replaceFullIndex } from "../src/storage/sqlite-index-store.js";
import type { StructuralIndex } from "../src/extraction/types.js";
import type { Database } from "../src/storage/sqlite-db.js";
import { importScipEdges } from "../src/scip/scip-to-edges.js";
import { scipSymbolShortName, isDefinition } from "../src/scip/parse-scip.js";
import type { ScipIndex, ScipOccurrence } from "../src/scip/types.js";
import { SymbolRole } from "../src/scip/types.js";

function makeTestIndex(): StructuralIndex {
  return {
    schema_version: "1.0.0",
    generated_at: new Date().toISOString(),
    manifest_hash: "abc123",
    file_count: 2,
    symbol_count: 4,
    files: [
      {
        relative_path: "src/main.ts",
        language: "typescript",
        symbols: [
          { name: "main", kind: "function", start_line: 1, end_line: 10 },
          { name: "helper", kind: "function", start_line: 12, end_line: 20 },
        ],
        imports: [{ source: "./utils", resolved_path: "src/utils.ts", symbols: ["doWork"] }],
        edges: [
          { kind: "calls", from_symbol: "main", to: "doWork", line: 5 },
        ],
        parse_errors: [],
      },
      {
        relative_path: "src/utils.ts",
        language: "typescript",
        symbols: [
          { name: "doWork", kind: "function", start_line: 1, end_line: 15 },
          { name: "internal", kind: "function", start_line: 17, end_line: 25 },
        ],
        imports: [],
        edges: [
          { kind: "calls", from_symbol: "doWork", to: "internal", line: 8 },
        ],
        parse_errors: [],
      },
    ],
    coverage_by_language: {
      typescript: { files_eligible: 2, files_parsed: 2, symbols: 4, coverage_level: "full" },
    },
  };
}

function makeScipIndex(): ScipIndex {
  return {
    documents: [
      {
        relativePath: "src/main.ts",
        occurrences: [
          // main é definição
          { range: { startLine: 0, startCol: 9, endLine: 0, endCol: 13 }, symbol: "npm . src/main.ts/main().", symbolRoles: 1 },
          // helper é definição
          { range: { startLine: 11, startCol: 9, endLine: 11, endCol: 15 }, symbol: "npm . src/main.ts/helper().", symbolRoles: 1 },
          // main chama doWork (referência dentro do range de main, linhas 0-9)
          { range: { startLine: 4, startCol: 2, endLine: 4, endCol: 8 }, symbol: "npm . src/utils.ts/doWork().", symbolRoles: 0 },
          // main chama helper (referência)
          { range: { startLine: 7, startCol: 2, endLine: 7, endCol: 8 }, symbol: "npm . src/main.ts/helper().", symbolRoles: 0 },
        ],
      },
      {
        relativePath: "src/utils.ts",
        occurrences: [
          // doWork é definição
          { range: { startLine: 0, startCol: 9, endLine: 0, endCol: 15 }, symbol: "npm . src/utils.ts/doWork().", symbolRoles: 1 },
          // internal é definição
          { range: { startLine: 16, startCol: 9, endLine: 16, endCol: 17 }, symbol: "npm . src/utils.ts/internal().", symbolRoles: 1 },
          // doWork chama internal (referência dentro do range de doWork, linhas 0-14)
          { range: { startLine: 7, startCol: 2, endLine: 7, endCol: 10 }, symbol: "npm . src/utils.ts/internal().", symbolRoles: 0 },
        ],
      },
    ],
  };
}

describe("SCIP", () => {
  let tmpDir: string;
  let dbPath: string;
  let db: Database;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "argus-scip-test-"));
    mkdirSync(join(tmpDir, ".argus"), { recursive: true });
    dbPath = join(tmpDir, ".argus", "index.db");
    db = openIndexDb(dbPath);
    replaceFullIndex(db, makeTestIndex());
  });

  afterEach(() => {
    closeIndexDb(db);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("parse-scip helpers", () => {
    it("scipSymbolShortName extrai nome curto de moniker", () => {
      expect(scipSymbolShortName("npm . src/utils.ts/doWork().")).toBe("doWork");
      expect(scipSymbolShortName("npm . src/main.ts/helper().")).toBe("helper");
      expect(scipSymbolShortName("npm @scope/pkg src/Foo.bar().")).toBe("bar");
    });

    it("isDefinition detecta bit de definição", () => {
      const def: ScipOccurrence = {
        range: { startLine: 0, startCol: 0, endLine: 0, endCol: 5 },
        symbol: "test",
        symbolRoles: SymbolRole.Definition,
      };
      const ref: ScipOccurrence = {
        range: { startLine: 0, startCol: 0, endLine: 0, endCol: 5 },
        symbol: "test",
        symbolRoles: 0,
      };
      expect(isDefinition(def)).toBe(true);
      expect(isDefinition(ref)).toBe(false);
    });
  });

  describe("scip-to-edges", () => {
    it("importa edges SCIP e marca source='scip'", () => {
      const scipIndex = makeScipIndex();
      const result = importScipEdges(db, scipIndex);

      expect(result.edgesImported).toBeGreaterThan(0);
      expect(result.filesMatched).toBe(2);
      expect(result.filesMissing).toBe(0);

      const edges = db.prepare("SELECT * FROM edges WHERE source = 'scip'").all() as Array<{
        kind: string; from_symbol: string; target_name: string; source: string;
      }>;
      expect(edges.length).toBe(result.edgesImported);
      expect(edges.every((e) => e.source === "scip")).toBe(true);
    });

    it("sobrescreve edges heurísticas do mesmo par from_symbol/target_name", () => {
      const scipIndex = makeScipIndex();

      // Antes: edge heurística main→doWork
      const beforeEdges = db.prepare(
        "SELECT source FROM edges WHERE from_symbol = 'main' AND target_name = 'doWork'",
      ).all() as Array<{ source: string }>;
      expect(beforeEdges.length).toBe(1);
      expect(beforeEdges[0]!.source).toBe("heuristic");

      importScipEdges(db, scipIndex);

      // Depois: somente edge SCIP main→doWork
      const afterEdges = db.prepare(
        "SELECT source FROM edges WHERE from_symbol = 'main' AND target_name = 'doWork'",
      ).all() as Array<{ source: string }>;
      expect(afterEdges.length).toBe(1);
      expect(afterEdges[0]!.source).toBe("scip");
    });

    it("retorna filesMissing quando path SCIP não casa com o índice", () => {
      const scipIndex: ScipIndex = {
        documents: [{
          relativePath: "nonexistent/file.ts",
          occurrences: [
            { range: { startLine: 0, startCol: 0, endLine: 0, endCol: 5 }, symbol: "test", symbolRoles: 0 },
          ],
        }],
      };
      const result = importScipEdges(db, scipIndex);
      expect(result.filesMissing).toBe(1);
      expect(result.filesMatched).toBe(0);
      expect(result.edgesImported).toBe(0);
    });
  });

  describe("migração v5", () => {
    it("edges existentes têm source='heuristic' após migração", () => {
      const rows = db.prepare("SELECT DISTINCT source FROM edges").all() as Array<{ source: string }>;
      expect(rows.length).toBe(1);
      expect(rows[0]!.source).toBe("heuristic");
    });

    it("coluna source existe na tabela edges", () => {
      const info = db.prepare("PRAGMA table_info(edges)").all() as Array<{ name: string }>;
      const colNames = info.map((col) => col.name);
      expect(colNames).toContain("source");
    });
  });

  describe("degradação honesta", () => {
    it("sem index.scip → comportamento inalterado (edges heurísticas preservadas)", () => {
      // Não importamos SCIP; edges continuam como antes
      const edges = db.prepare("SELECT * FROM edges").all() as Array<{ source: string }>;
      expect(edges.length).toBeGreaterThan(0);
      expect(edges.every((e) => e.source === "heuristic")).toBe(true);
    });
  });
});
