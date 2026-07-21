import type { DiscoveryManifest } from "../discovery/types.js";
import {
  buildCoverageSummary,
  buildCoverageSummaryFromAggregates,
  buildExtractionLimitations,
  buildExtractionLimitationsFromCounts,
} from "./coverage.js";
import { extractFile } from "./extract-file.js";
import { buildStructuralIndexDocument } from "./index-store.js";
import { detectLanguageFromPath } from "./language.js";
import { computeManifestHash } from "./manifest-hash.js";
import { initAllParsers } from "./parsers/registry.js";
import type { FileStructuralEntry, StructuralIndex } from "./types.js";
import type { Database } from "../storage/sqlite-db.js";
import { readCoverageAggregatesFromDb } from "../storage/sqlite-index-store.js";

export interface ExtractionSummary {
  files_parsed: number;
  symbol_count: number;
  duration_ms: number;
}

function manifestPathsSet(manifest: DiscoveryManifest): Set<string> {
  return new Set(manifest.files.map((file) => file.relative_path));
}

function isEligibleForExtraction(relativePath: string): boolean {
  return detectLanguageFromPath(relativePath).status === "supported";
}

export async function buildStructuralIndex(
  manifest: DiscoveryManifest,
  rootPath: string,
): Promise<{ index: StructuralIndex; summary: ExtractionSummary }> {
  const started = Date.now();
  await initAllParsers();

  const manifestHash = computeManifestHash(manifest);
  const entries: FileStructuralEntry[] = [];

  for (const file of manifest.files) {
    if (!isEligibleForExtraction(file.relative_path)) {
      continue;
    }
    entries.push(extractFile(rootPath, file.relative_path));
  }

  const manifestPaths = manifest.files.map((file) => file.relative_path);
  const coverage = buildCoverageSummary(entries, manifestPaths);
  const limitations = buildExtractionLimitations(manifestPaths, entries);
  const index = buildStructuralIndexDocument(manifestHash, entries, coverage, limitations);

  return {
    index,
    summary: {
      files_parsed: entries.length,
      symbol_count: index.symbol_count,
      duration_ms: Date.now() - started,
    },
  };
}

/**
 * Extrai apenas paths alterados (sem carregar o índice anterior). Cobertura e
 * limitations finais vêm de {@link computeStructuralMetaAfterDelta} após o upsert SQLite.
 */
export async function extractChangedStructuralFiles(
  manifest: DiscoveryManifest,
  rootPath: string,
  changedPaths: string[],
): Promise<{
  upsertedFiles: FileStructuralEntry[];
  manifestHash: string;
  summary: ExtractionSummary;
}> {
  const started = Date.now();
  await initAllParsers();

  const allowed = manifestPathsSet(manifest);
  const toReextract = changedPaths.filter(
    (path) => allowed.has(path) && isEligibleForExtraction(path),
  );
  const upsertedFiles = toReextract.map((path) => extractFile(rootPath, path));
  const symbolCount = upsertedFiles.reduce((sum, file) => sum + file.symbols.length, 0);

  return {
    upsertedFiles,
    manifestHash: computeManifestHash(manifest),
    summary: {
      files_parsed: toReextract.length,
      symbol_count: symbolCount,
      duration_ms: Date.now() - started,
    },
  };
}

/** Recalcula coverage/limitations a partir do DB já atualizado (sem full-load). */
export function computeStructuralMetaAfterDelta(
  db: Database,
  manifest: DiscoveryManifest,
): {
  coverage: StructuralIndex["coverage_by_language"];
  extractionLimitations: string[];
} {
  const manifestPaths = manifest.files.map((file) => file.relative_path);
  const aggregates = readCoverageAggregatesFromDb(db);
  return {
    coverage: buildCoverageSummaryFromAggregates(aggregates.byLanguage, manifestPaths),
    extractionLimitations: buildExtractionLimitationsFromCounts(
      manifestPaths,
      aggregates.parseErrorFileCount,
    ),
  };
}

/**
 * @deprecated Prefer {@link extractChangedStructuralFiles} + persistência delta.
 * Mantido para callers que ainda passam o índice anterior materializado.
 */
export async function updateStructuralIndexDelta(
  manifest: DiscoveryManifest,
  rootPath: string,
  previousIndex: StructuralIndex | null,
  changedPaths: string[],
  removedPaths: string[],
): Promise<{ index: StructuralIndex; summary: ExtractionSummary }> {
  const started = Date.now();
  await initAllParsers();

  const manifestHash = computeManifestHash(manifest);
  const allowed = manifestPathsSet(manifest);
  const previousMap = new Map(
    (previousIndex?.files ?? []).map((entry) => [entry.relative_path, entry] as const),
  );

  for (const removed of removedPaths) {
    previousMap.delete(removed);
  }

  const toReextract = changedPaths.filter(
    (path) => allowed.has(path) && isEligibleForExtraction(path),
  );

  for (const path of toReextract) {
    previousMap.set(path, extractFile(rootPath, path));
  }

  const entries = [...previousMap.values()].filter((entry) => allowed.has(entry.relative_path));
  const manifestPaths = manifest.files.map((file) => file.relative_path);
  const coverage = buildCoverageSummary(entries, manifestPaths);
  const limitations = buildExtractionLimitations(manifestPaths, entries);
  const index = buildStructuralIndexDocument(manifestHash, entries, coverage, limitations);

  return {
    index,
    summary: {
      files_parsed: toReextract.length,
      symbol_count: index.symbol_count,
      duration_ms: Date.now() - started,
    },
  };
}
