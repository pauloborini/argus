import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { FileStructuralEntry, StructuralIndex } from "./types.js";
import { STRUCTURAL_INDEX_SCHEMA_VERSION } from "./types.js";

export class StructuralIndexCorruptedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StructuralIndexCorruptedError";
  }
}

function isFileEntry(value: unknown): value is FileStructuralEntry {
  if (!value || typeof value !== "object") {
    return false;
  }
  const entry = value as Partial<FileStructuralEntry>;
  return (
    typeof entry.relative_path === "string" &&
    typeof entry.language === "string" &&
    Array.isArray(entry.symbols) &&
    Array.isArray(entry.imports) &&
    Array.isArray(entry.edges) &&
    Array.isArray(entry.parse_errors)
  );
}

function isStructuralIndexLike(value: unknown): value is StructuralIndex {
  if (!value || typeof value !== "object") {
    return false;
  }

  const index = value as Partial<StructuralIndex>;
  return (
    typeof index.schema_version === "string" &&
    typeof index.generated_at === "string" &&
    typeof index.manifest_hash === "string" &&
    typeof index.file_count === "number" &&
    typeof index.symbol_count === "number" &&
    Array.isArray(index.files) &&
    index.files.every((file) => isFileEntry(file)) &&
    typeof index.coverage_by_language === "object" &&
    index.coverage_by_language !== null
  );
}

export function readStructuralIndex(indexPath: string): StructuralIndex | null {
  if (!existsSync(indexPath)) {
    return null;
  }

  try {
    const raw = readFileSync(indexPath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isStructuralIndexLike(parsed)) {
      throw new StructuralIndexCorruptedError(
        "E_INDEX_CORRUPTED: Índice estrutural corrompido ou inválido; execute cortex index para reconstruir.",
      );
    }
    return parsed;
  } catch (err) {
    if (err instanceof StructuralIndexCorruptedError) {
      throw err;
    }
    throw new StructuralIndexCorruptedError(
      "E_INDEX_CORRUPTED: Índice estrutural ilegível; execute cortex index para reconstruir.",
    );
  }
}

export function writeStructuralIndexAtomic(indexPath: string, index: StructuralIndex): void {
  mkdirSync(dirname(indexPath), { recursive: true });
  const tempPath = `${indexPath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempPath, JSON.stringify(index, null, 2) + "\n", "utf-8");
  renameSync(tempPath, indexPath);
}

export function buildStructuralIndexDocument(
  manifestHash: string,
  files: FileStructuralEntry[],
  coverage: StructuralIndex["coverage_by_language"],
): StructuralIndex {
  const sortedFiles = [...files].sort((a, b) => a.relative_path.localeCompare(b.relative_path));
  const symbolCount = sortedFiles.reduce((sum, file) => sum + file.symbols.length, 0);

  return {
    schema_version: STRUCTURAL_INDEX_SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    manifest_hash: manifestHash,
    file_count: sortedFiles.length,
    symbol_count: symbolCount,
    files: sortedFiles,
    coverage_by_language: coverage,
  };
}
