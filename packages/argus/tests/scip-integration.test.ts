import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openIndexDb, closeIndexDb, replaceFullIndex } from "../src/storage/sqlite-index-store.js";
import type { StructuralIndex } from "../src/extraction/types.js";
import type { Database } from "../src/storage/sqlite-db.js";
import { importScipEdges } from "../src/scip/scip-to-edges.js";
import { decodeScipBuffer } from "../src/scip/parse-scip.js";
import protobufjs from "protobufjs";

const { Type, Field } = protobufjs;

function encodeScipIndex(payload: object): Uint8Array {
  const Occurrence = new Type("Occurrence")
    .add(new Field("range", 1, "int32", "repeated"))
    .add(new Field("symbol", 2, "string"))
    .add(new Field("symbolRoles", 3, "int32"));
  const Document = new Type("Document")
    .add(new Field("relativePath", 1, "string"))
    .add(new Field("occurrences", 2, "Occurrence", "repeated"))
    .add(Occurrence);
  const Index = new Type("Index")
    .add(new Field("documents", 1, "Document", "repeated"))
    .add(Document);
  const msg = Index.create(payload);
  return Index.encode(msg).finish();
}

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
        edges: [{ kind: "calls", from_symbol: "main", to: "doWork", line: 5 }],
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
        edges: [{ kind: "calls", from_symbol: "doWork", to: "internal", line: 8 }],
        parse_errors: [],
      },
    ],
    coverage_by_language: {
      typescript: { files_eligible: 2, files_parsed: 2, symbols: 4, coverage_level: "full" },
    },
  };
}

describe("SCIP integration (protobuf encode/decode)", () => {
  let tmpDir: string;
  let dbPath: string;
  let db: Database;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "argus-scip-int-"));
    mkdirSync(join(tmpDir, ".argus"), { recursive: true });
    dbPath = join(tmpDir, ".argus", "index.db");
    db = openIndexDb(dbPath);
    replaceFullIndex(db, makeTestIndex());
  });

  afterEach(() => {
    closeIndexDb(db);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("decode de protobuf real → importação de edges SCIP funciona ponta-a-ponta", async () => {
    const scipPayload = {
      documents: [
        {
          relativePath: "src/main.ts",
          occurrences: [
            { range: [0, 9, 13], symbol: "npm . src/main.ts/main().", symbolRoles: 1 },
            { range: [11, 9, 15], symbol: "npm . src/main.ts/helper().", symbolRoles: 1 },
            { range: [4, 2, 8], symbol: "npm . src/utils.ts/doWork().", symbolRoles: 0 },
            { range: [7, 2, 8], symbol: "npm . src/main.ts/helper().", symbolRoles: 0 },
          ],
        },
        {
          relativePath: "src/utils.ts",
          occurrences: [
            { range: [0, 9, 15], symbol: "npm . src/utils.ts/doWork().", symbolRoles: 1 },
            { range: [16, 9, 17], symbol: "npm . src/utils.ts/internal().", symbolRoles: 1 },
            { range: [7, 2, 10], symbol: "npm . src/utils.ts/internal().", symbolRoles: 0 },
          ],
        },
      ],
    };

    const buf = encodeScipIndex(scipPayload);
    const scipIndex = await decodeScipBuffer(buf);

    expect(scipIndex.documents.length).toBe(2);
    expect(scipIndex.documents[0]!.relativePath).toBe("src/main.ts");

    const result = importScipEdges(db, scipIndex);
    expect(result.edgesImported).toBeGreaterThan(0);
    expect(result.filesMatched).toBe(2);
    expect(result.filesMissing).toBe(0);

    const scipEdges = db.prepare("SELECT * FROM edges WHERE source = 'scip'").all() as Array<{
      from_symbol: string; target_name: string; source: string; line: number;
    }>;
    expect(scipEdges.length).toBe(result.edgesImported);

    // main→doWork SCIP edge exists
    const mainDoWork = scipEdges.find((e) => e.from_symbol === "main" && e.target_name === "doWork");
    expect(mainDoWork).toBeDefined();
    expect(mainDoWork!.line).toBe(5);

    // main→helper SCIP edge exists
    const mainHelper = scipEdges.find((e) => e.from_symbol === "main" && e.target_name === "helper");
    expect(mainHelper).toBeDefined();

    // doWork→internal SCIP edge exists
    const doWorkInternal = scipEdges.find((e) => e.from_symbol === "doWork" && e.target_name === "internal");
    expect(doWorkInternal).toBeDefined();

    // Heuristic edge main→doWork was replaced
    const heuristicMainDoWork = db.prepare(
      "SELECT * FROM edges WHERE from_symbol = 'main' AND target_name = 'doWork' AND source = 'heuristic'",
    ).all();
    expect(heuristicMainDoWork.length).toBe(0);
  });
});
