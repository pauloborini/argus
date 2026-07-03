/**
 * Contrato puro memória v2 — sem side effects, sem I/O.
 * Consumível por migração (S03) e leitura (S05).
 */

export const MEMORY_V2_SCOPE_VALUES = [
  "project",
  "user",
  "session",
  "agent",
  "org",
] as const;

export type MemoryV2Scope = (typeof MEMORY_V2_SCOPE_VALUES)[number];

export const MEMORY_V2_ACTIVE_SCOPES = [
  "project",
  "user",
  "session",
  "agent",
] as const;

export type MemoryV2ActiveScope = (typeof MEMORY_V2_ACTIVE_SCOPES)[number];

export const MEMORY_V2_RESERVED_SCOPES = ["org"] as const;

export type MemoryV2ReservedScope = (typeof MEMORY_V2_RESERVED_SCOPES)[number];

export const MEMORY_V2_SOURCE_VALUES = [
  "direct_capture",
  "agent_inference",
  "v1_migration",
  "document_import",
] as const;

export type MemoryV2Source = (typeof MEMORY_V2_SOURCE_VALUES)[number];

export const MEMORY_V2_CONFIDENCE_VALUES = [
  "confirmed",
  "inferred",
  "presumed",
] as const;

export type MemoryV2Confidence = (typeof MEMORY_V2_CONFIDENCE_VALUES)[number];

/** Nível mais conservador quando confiança ausente (PRD D3). */
export const MEMORY_V2_DEFAULT_CONFIDENCE: MemoryV2Confidence = "presumed";

/** Default explícito na migração S03 para notas v1. */
export const MEMORY_V2_V1_MIGRATION_DEFAULT_SCOPE: MemoryV2ActiveScope = "project";

export const MEMORY_V2_V1_MIGRATION_DEFAULT_SOURCE: MemoryV2Source = "v1_migration";

export const MEMORY_V2_SCOPE_REJECTED_CODE = "E_MEMORY_V2_SCOPE_REJECTED";
export const MEMORY_V2_SOURCE_INVALID_CODE = "E_MEMORY_V2_SOURCE_INVALID";
export const MEMORY_V2_SUPERSEDENCE_INVALID_CODE = "E_MEMORY_V2_SUPERSEDENCE_INVALID";
export const MEMORY_V2_STALE_REASON_REQUIRED_CODE = "E_MEMORY_V2_STALE_REASON_REQUIRED";
export const MEMORY_V2_CONTRADICTION_REASON_REQUIRED_CODE =
  "E_MEMORY_V2_CONTRADICTION_REASON_REQUIRED";

export interface MemoryV2SupersedenceRef {
  superseded_by?: string;
  supersedes?: string;
}

export interface MemoryV2QualitySignals {
  stale_reason?: string;
  contradiction_reason?: string;
}

export interface MemoryV2OptionalTemporalFields {
  valid_from?: string;
  valid_until?: string;
}

export interface MemoryV2FactFields
  extends MemoryV2OptionalTemporalFields,
    MemoryV2SupersedenceRef,
    MemoryV2QualitySignals {
  scope: MemoryV2ActiveScope;
  source: MemoryV2Source;
  confidence: MemoryV2Confidence;
  observed_at: string;
  migrated_from_v1?: string;
}

export type MemoryV2WritableScopeResult =
  | { ok: true; scope: MemoryV2ActiveScope }
  | { ok: false; code: typeof MEMORY_V2_SCOPE_REJECTED_CODE; message: string };

export type MemoryV2SourceResult =
  | { ok: true; source: MemoryV2Source }
  | { ok: false; code: typeof MEMORY_V2_SOURCE_INVALID_CODE; message: string };

export type MemoryV2ConfidenceResult = { ok: true; confidence: MemoryV2Confidence };

export type MemoryV2SupersedenceResult =
  | { ok: true; superseded_by: string }
  | { ok: false; code: typeof MEMORY_V2_SUPERSEDENCE_INVALID_CODE; message: string };

export type MemoryV2LinkSupersedenceResult =
  | { ok: true; origin: MemoryV2SupersedenceRef; current: MemoryV2SupersedenceRef }
  | { ok: false; code: typeof MEMORY_V2_SUPERSEDENCE_INVALID_CODE; message: string };

export type MemoryV2StaleSignalResult =
  | { ok: true; stale_reason: string }
  | { ok: false; code: typeof MEMORY_V2_STALE_REASON_REQUIRED_CODE; message: string };

export type MemoryV2ContradictionSignalResult =
  | { ok: true; contradiction_reason: string }
  | {
      ok: false;
      code: typeof MEMORY_V2_CONTRADICTION_REASON_REQUIRED_CODE;
      message: string;
    };

function isActiveScope(value: string): value is MemoryV2ActiveScope {
  return (MEMORY_V2_ACTIVE_SCOPES as readonly string[]).includes(value);
}

function isReservedScope(value: string): value is MemoryV2ReservedScope {
  return (MEMORY_V2_RESERVED_SCOPES as readonly string[]).includes(value);
}

export function isMemoryV2Scope(value: string): value is MemoryV2Scope {
  return (MEMORY_V2_SCOPE_VALUES as readonly string[]).includes(value);
}

export function isMemoryV2Source(value: string): value is MemoryV2Source {
  return (MEMORY_V2_SOURCE_VALUES as readonly string[]).includes(value);
}

export function isMemoryV2Confidence(value: string): value is MemoryV2Confidence {
  return (MEMORY_V2_CONFIDENCE_VALUES as readonly string[]).includes(value);
}

/** Rejeita `org` e escopos desconhecidos para gravação (PRD D1). */
export function assertWritableScope(scope: string): MemoryV2WritableScopeResult {
  if (isReservedScope(scope)) {
    return {
      ok: false,
      code: MEMORY_V2_SCOPE_REJECTED_CODE,
      message: `scope "${scope}" is reserved and cannot receive writes; active scopes: ${MEMORY_V2_ACTIVE_SCOPES.join(", ")}`,
    };
  }
  if (!isActiveScope(scope)) {
    return {
      ok: false,
      code: MEMORY_V2_SCOPE_REJECTED_CODE,
      message: `unknown scope "${scope}"; active scopes: ${MEMORY_V2_ACTIVE_SCOPES.join(", ")}`,
    };
  }
  return { ok: true, scope };
}

/** Fonte obrigatória e não vazia (PRD D2). */
export function normalizeSource(source: string | undefined | null): MemoryV2SourceResult {
  const trimmed = source?.trim() ?? "";
  if (!trimmed) {
    return {
      ok: false,
      code: MEMORY_V2_SOURCE_INVALID_CODE,
      message: "source is required and cannot be empty",
    };
  }
  if (!isMemoryV2Source(trimmed)) {
    return {
      ok: false,
      code: MEMORY_V2_SOURCE_INVALID_CODE,
      message: `invalid source "${trimmed}"; allowed: ${MEMORY_V2_SOURCE_VALUES.join(", ")}`,
    };
  }
  return { ok: true, source: trimmed };
}

/** Ausência assume nível mais conservador (PRD D3). */
export function normalizeConfidence(
  confidence: string | undefined | null,
): MemoryV2ConfidenceResult {
  const trimmed = confidence?.trim() ?? "";
  if (!trimmed) {
    return { ok: true, confidence: MEMORY_V2_DEFAULT_CONFIDENCE };
  }
  if (!isMemoryV2Confidence(trimmed)) {
    return { ok: true, confidence: MEMORY_V2_DEFAULT_CONFIDENCE };
  }
  return { ok: true, confidence: trimmed };
}

/**
 * Supersedência exige referência ao fato vigente; origem nunca é apagada (PRD D4).
 */
export function assertSupersedenceRef(
  supersededBy: string | undefined | null,
): MemoryV2SupersedenceResult {
  const trimmed = supersededBy?.trim() ?? "";
  if (!trimmed) {
    return {
      ok: false,
      code: MEMORY_V2_SUPERSEDENCE_INVALID_CODE,
      message: "superseded_by must reference the current fact id",
    };
  }
  return { ok: true, superseded_by: trimmed };
}

/** Staleness exige motivo acionável (PRD D5). */
export function assertStaleReason(reason: string | undefined | null): MemoryV2StaleSignalResult {
  const trimmed = reason?.trim() ?? "";
  if (!trimmed) {
    return {
      ok: false,
      code: MEMORY_V2_STALE_REASON_REQUIRED_CODE,
      message: "stale facts require an actionable stale_reason",
    };
  }
  return { ok: true, stale_reason: trimmed };
}

/** Contradição exige motivo acionável (PRD D5). */
export function assertContradictionReason(
  reason: string | undefined | null,
): MemoryV2ContradictionSignalResult {
  const trimmed = reason?.trim() ?? "";
  if (!trimmed) {
    return {
      ok: false,
      code: MEMORY_V2_CONTRADICTION_REASON_REQUIRED_CODE,
      message: "contradictory facts require an actionable contradiction_reason",
    };
  }
  return { ok: true, contradiction_reason: trimmed };
}

/** Marca supersedência bidirecional sem apagar o fato de origem. */
export function linkSupersedence(
  originId: string,
  currentId: string,
): MemoryV2LinkSupersedenceResult {
  const origin = originId.trim();
  const current = currentId.trim();
  if (!origin || !current) {
    return {
      ok: false,
      code: MEMORY_V2_SUPERSEDENCE_INVALID_CODE,
      message: "origin and current fact ids are required for supersedence links",
    };
  }
  return {
    ok: true,
    origin: { superseded_by: current },
    current: { supersedes: origin },
  };
}

/** v1 permanece fonte migrável e pesquisável (PRD D6). */
export function v1NoteIsMigratable(): true {
  return true;
}
