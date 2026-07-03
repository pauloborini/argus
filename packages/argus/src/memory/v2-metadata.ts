import {
  MEMORY_V2_DEFAULT_CONFIDENCE,
  MEMORY_V2_V1_MIGRATION_DEFAULT_SCOPE,
  MEMORY_V2_V1_MIGRATION_DEFAULT_SOURCE,
  assertWritableScope,
  normalizeConfidence,
  normalizeSource,
  type MemoryV2ActiveScope,
  type MemoryV2Confidence,
  type MemoryV2Source,
} from "./v2-contract.js";
import type { MemoryV2NoteExtension } from "./v2-persistence-draft.js";
import type { ParsedMarkdown } from "./markdown-parser.js";

export interface V2MetadataContext {
  notePath: string;
  observedAt: string;
  /** Nota sem nenhum campo v2 no frontmatter (migração v1). */
  isLegacyV1Note: boolean;
}

export interface NormalizedV2Metadata extends MemoryV2NoteExtension {
  warnings: string[];
}

function emptyOptional(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed || null;
}

/** Defaults D1 para captura nova via remember/sync. */
export function defaultDirectCaptureV2(observedAt: string): MemoryV2NoteExtension {
  return {
    scope: "project",
    source: "direct_capture",
    confidence: MEMORY_V2_DEFAULT_CONFIDENCE,
    observed_at: observedAt,
    valid_from: null,
    valid_until: null,
    superseded_by: null,
    supersedes: null,
    stale_reason: null,
    contradiction_reason: null,
    migrated_from_v1: null,
  };
}

/** Defaults D2 para nota v1 migrada. */
export function defaultV1MigrationV2(notePath: string, observedAt: string): MemoryV2NoteExtension {
  return {
    scope: MEMORY_V2_V1_MIGRATION_DEFAULT_SCOPE,
    source: MEMORY_V2_V1_MIGRATION_DEFAULT_SOURCE,
    confidence: MEMORY_V2_DEFAULT_CONFIDENCE,
    observed_at: observedAt,
    valid_from: null,
    valid_until: null,
    superseded_by: null,
    supersedes: null,
    stale_reason: null,
    contradiction_reason: null,
    migrated_from_v1: notePath,
  };
}

function resolveScope(
  raw: string | undefined,
  fallback: MemoryV2ActiveScope,
  warnings: string[],
): MemoryV2ActiveScope {
  if (!raw?.trim()) {
    return fallback;
  }
  const result = assertWritableScope(raw.trim());
  if (!result.ok) {
    warnings.push(result.message);
    return fallback;
  }
  return result.scope;
}

function resolveSource(
  raw: string | undefined,
  fallback: MemoryV2Source,
  warnings: string[],
): MemoryV2Source {
  if (!raw?.trim()) {
    return fallback;
  }
  const result = normalizeSource(raw);
  if (!result.ok) {
    warnings.push(result.message);
    return fallback;
  }
  return result.source;
}

function resolveConfidence(raw: string | undefined, warnings: string[]): MemoryV2Confidence {
  const result = normalizeConfidence(raw);
  if (raw?.trim() && result.confidence === MEMORY_V2_DEFAULT_CONFIDENCE && raw.trim() !== MEMORY_V2_DEFAULT_CONFIDENCE) {
    warnings.push(`invalid confidence "${raw}"; using ${MEMORY_V2_DEFAULT_CONFIDENCE}`);
  }
  return result.confidence;
}

/**
 * Normaliza metadados v2 a partir do frontmatter parseado (PRD D1/D2/D3).
 * Frontmatter inválido gera warning e default seguro — não derruba o cofre.
 */
export function normalizeV2Metadata(
  parsed: ParsedMarkdown,
  context: V2MetadataContext,
): NormalizedV2Metadata {
  const warnings: string[] = [];
  const base = context.isLegacyV1Note
    ? defaultV1MigrationV2(context.notePath, context.observedAt)
    : defaultDirectCaptureV2(context.observedAt);

  const scope = resolveScope(parsed.scope, base.scope, warnings);
  const source = resolveSource(parsed.source, base.source, warnings);
  const confidence = resolveConfidence(parsed.confidence, warnings);

  return {
    scope,
    source,
    confidence,
    observed_at: emptyOptional(parsed.observed_at) ?? base.observed_at,
    valid_from: emptyOptional(parsed.valid_from),
    valid_until: emptyOptional(parsed.valid_until),
    superseded_by: emptyOptional(parsed.superseded_by),
    supersedes: emptyOptional(parsed.supersedes),
    stale_reason: emptyOptional(parsed.stale_reason),
    contradiction_reason: emptyOptional(parsed.contradiction_reason),
    migrated_from_v1: emptyOptional(parsed.migrated_from_v1) ?? base.migrated_from_v1,
    warnings,
  };
}

export function isLegacyV1Note(parsed: ParsedMarkdown): boolean {
  const hasSource = Boolean(parsed.source?.trim());
  const hasMigratedFrom = Boolean(parsed.migrated_from_v1?.trim());
  return !hasSource && !hasMigratedFrom;
}
