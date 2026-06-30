import { describe, expect, it } from "vitest";
import {
  buildCoverageSummary,
  buildExtractionLimitations,
  countEligibleByLanguage,
  countUnsupportedManifestFiles,
} from "../src/extraction/coverage.js";
import type { FileStructuralEntry } from "../src/extraction/types.js";

describe("coverage", () => {
  const tsEntry: FileStructuralEntry = {
    relative_path: "a.ts",
    language: "typescript",
    symbols: [{ name: "foo", kind: "function", start_line: 1, end_line: 2 }],
    imports: [],
    edges: [],
    parse_errors: [],
  };

  it("conta elegíveis por linguagem a partir do manifest", () => {
    const counts = countEligibleByLanguage(["a.ts", "b.py", "readme.md"]);
    expect(counts.typescript).toBe(1);
    expect(counts.python).toBe(1);
    expect(countUnsupportedManifestFiles(["a.ts", "b.py", "readme.md"])).toBe(1);
  });

  it("files_eligible reflete manifest, não só entradas parseadas", () => {
    const coverage = buildCoverageSummary([tsEntry], ["a.ts", "b.ts", "readme.md"]);
    expect(coverage.typescript?.files_eligible).toBe(2);
    expect(coverage.typescript?.files_parsed).toBe(1);
  });

  it("gera limitations para não suportados e parse errors", () => {
    const failedEntry: FileStructuralEntry = {
      ...tsEntry,
      relative_path: "bad.ts",
      parse_errors: [{ message: "syntax error" }],
      symbols: [],
    };

    const limitations = buildExtractionLimitations(
      ["a.ts", "readme.md", "bad.ts"],
      [tsEntry, failedEntry],
    );

    expect(limitations.some((line) => line.includes("não suportada"))).toBe(true);
    expect(limitations.some((line) => line.includes("erro de parse"))).toBe(true);
  });
});
