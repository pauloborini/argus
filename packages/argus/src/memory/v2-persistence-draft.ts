/**
 * Draft de persistência memória v2 — contrato puro, NÃO executado por openMemoryDb.
 * Migração real e bump de MEMORY_SQLITE_SCHEMA_VERSION ficam em S03.
 */

import type { MemoryV2Confidence, MemoryV2Source, MemoryV2ActiveScope } from "./v2-contract.js";

/** Campos v2 planejados para extensão da tabela `notes` ou equivalente futura. */
export interface MemoryV2NoteExtension {
  scope: MemoryV2ActiveScope;
  source: MemoryV2Source;
  confidence: MemoryV2Confidence;
  observed_at: string | null;
  valid_from: string | null;
  valid_until: string | null;
  superseded_by: string | null;
  supersedes: string | null;
  stale_reason: string | null;
  contradiction_reason: string | null;
  migrated_from_v1: string | null;
}

export const MEMORY_V2_NOTE_EXTENSION_FIELD_NAMES = [
  "scope",
  "source",
  "confidence",
  "observed_at",
  "valid_from",
  "valid_until",
  "superseded_by",
  "supersedes",
  "stale_reason",
  "contradiction_reason",
  "migrated_from_v1",
] as const satisfies readonly (keyof MemoryV2NoteExtension)[];

/**
 * SQL draft — não aplicado em runtime (schema v1 permanece 1.0.0).
 * S03 executará migração a partir deste contrato.
 */
export const MEMORY_V2_NOTES_EXTENSION_SQL_DRAFT = `
-- DRAFT ONLY — not executed by openMemoryDb in S02
-- Planned ALTER for notes (S03):
-- ALTER TABLE notes ADD COLUMN scope TEXT NOT NULL DEFAULT 'project';
-- ALTER TABLE notes ADD COLUMN source TEXT NOT NULL DEFAULT 'v1_migration';
-- ALTER TABLE notes ADD COLUMN confidence TEXT NOT NULL DEFAULT 'presumed';
-- ALTER TABLE notes ADD COLUMN observed_at TEXT;
-- ALTER TABLE notes ADD COLUMN valid_from TEXT;
-- ALTER TABLE notes ADD COLUMN valid_until TEXT;
-- ALTER TABLE notes ADD COLUMN superseded_by TEXT;
-- ALTER TABLE notes ADD COLUMN supersedes TEXT;
-- ALTER TABLE notes ADD COLUMN stale_reason TEXT;
-- ALTER TABLE notes ADD COLUMN contradiction_reason TEXT;
-- ALTER TABLE notes ADD COLUMN migrated_from_v1 TEXT;
`.trim();

/** Mapa PRD §5 → coluna draft para auditoria do validator. */
export const MEMORY_V2_PRD_FIELD_MAP: Record<string, keyof MemoryV2NoteExtension> = {
  escopo: "scope",
  fonte: "source",
  confianca: "confidence",
  temporalidade_observada: "observed_at",
  temporalidade_validade_inicio: "valid_from",
  temporalidade_validade_fim: "valid_until",
  supersedencia_vigente: "superseded_by",
  supersedencia_origem: "supersedes",
  stale: "stale_reason",
  contradicao: "contradiction_reason",
  compat_v1: "migrated_from_v1",
};
