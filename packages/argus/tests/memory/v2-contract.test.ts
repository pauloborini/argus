import { describe, expect, it } from "vitest";
import { MCP_TOOL_NAMES } from "../../src/mcp/tool-registry.js";
import { MEMORY_SQLITE_SCHEMA_VERSION } from "../../src/memory/storage/sqlite-schema.js";
import {
  MEMORY_V2_ACTIVE_SCOPES,
  MEMORY_V2_CONFIDENCE_VALUES,
  MEMORY_V2_DEFAULT_CONFIDENCE,
  MEMORY_V2_RESERVED_SCOPES,
  MEMORY_V2_SOURCE_VALUES,
  MEMORY_V2_V1_MIGRATION_DEFAULT_SCOPE,
  MEMORY_V2_V1_MIGRATION_DEFAULT_SOURCE,
  assertContradictionReason,
  assertStaleReason,
  assertSupersedenceRef,
  assertWritableScope,
  linkSupersedence,
  normalizeConfidence,
  normalizeSource,
  v1NoteIsMigratable,
  type MemoryV2FactFields,
} from "../../src/memory/v2-contract.js";
import {
  MEMORY_V2_NOTE_EXTENSION_FIELD_NAMES,
  MEMORY_V2_NOTES_EXTENSION_SQL_DRAFT,
  MEMORY_V2_PRD_FIELD_MAP,
} from "../../src/memory/v2-persistence-draft.js";

describe("memory v2 contract", () => {
  it("define escopos ativos exatamente project/user/session/agent", () => {
    expect([...MEMORY_V2_ACTIVE_SCOPES].sort()).toEqual(["agent", "project", "session", "user"]);
  });

  it("rejeita org e escopos desconhecidos para gravacao", () => {
    const org = assertWritableScope("org");
    expect(org.ok).toBe(false);
    if (!org.ok) {
      expect(org.code).toBe("E_MEMORY_V2_SCOPE_REJECTED");
    }

    const unknown = assertWritableScope("team");
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) {
      expect(unknown.message).toMatch(/unknown scope/);
    }

    const active = assertWritableScope("project");
    expect(active).toEqual({ ok: true, scope: "project" });
  });

  it("reserva org no vocabulario sem permitir gravacao", () => {
    expect(MEMORY_V2_RESERVED_SCOPES).toEqual(["org"]);
    expect(assertWritableScope("org").ok).toBe(false);
  });

  it("exige fonte nao vazia e normaliza confianca conservadora", () => {
    const empty = normalizeSource("");
    expect(empty.ok).toBe(false);
    if (!empty.ok) {
      expect(empty.code).toBe("E_MEMORY_V2_SOURCE_INVALID");
    }

    const valid = normalizeSource("direct_capture");
    expect(valid).toEqual({ ok: true, source: "direct_capture" });
    expect(MEMORY_V2_SOURCE_VALUES).toContain("v1_migration");

    const missing = normalizeConfidence(undefined);
    expect(missing).toEqual({ ok: true, confidence: MEMORY_V2_DEFAULT_CONFIDENCE });
    expect(MEMORY_V2_DEFAULT_CONFIDENCE).toBe("presumed");
    expect(MEMORY_V2_CONFIDENCE_VALUES.indexOf("presumed")).toBeGreaterThan(
      MEMORY_V2_CONFIDENCE_VALUES.indexOf("confirmed"),
    );
  });

  it("supersedencia exige referencia ao fato vigente sem apagar origem", () => {
    const invalid = assertSupersedenceRef("");
    expect(invalid.ok).toBe(false);

    const emptyLink = linkSupersedence("", "fb");
    expect(emptyLink.ok).toBe(false);

    const linked = linkSupersedence("fa", "fb");
    expect(linked.ok).toBe(true);
    if (linked.ok) {
      expect(linked.origin).toEqual({ superseded_by: "fb" });
      expect(linked.current).toEqual({ supersedes: "fa" });
      expect(linked.origin).not.toHaveProperty("deleted");
    }
  });

  it("exige observed_at em fato v2 completo", () => {
    const fact: MemoryV2FactFields = {
      scope: "project",
      source: "direct_capture",
      confidence: "confirmed",
      observed_at: "2026-07-03T12:00:00.000Z",
    };
    expect(fact.observed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("stale e contradicao exigem motivo acionavel", () => {
    expect(assertStaleReason("").ok).toBe(false);
    expect(assertStaleReason("session_expired")).toEqual({
      ok: true,
      stale_reason: "session_expired",
    });

    expect(assertContradictionReason(undefined).ok).toBe(false);
    expect(assertContradictionReason("conflicting_values_same_scope")).toEqual({
      ok: true,
      contradiction_reason: "conflicting_values_same_scope",
    });
  });

  it("preserva v1 como fonte migravel e pesquisavel", () => {
    expect(v1NoteIsMigratable()).toBe(true);
    expect(MEMORY_V2_V1_MIGRATION_DEFAULT_SCOPE).toBe("project");
    expect(MEMORY_V2_V1_MIGRATION_DEFAULT_SOURCE).toBe("v1_migration");
    expect(MEMORY_SQLITE_SCHEMA_VERSION).toBe("1.0.0");
  });

  it("mapeia campos PRD para draft de persistencia", () => {
    expect(MEMORY_V2_NOTE_EXTENSION_FIELD_NAMES).toEqual([
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
    ]);
    expect(MEMORY_V2_PRD_FIELD_MAP.escopo).toBe("scope");
    expect(MEMORY_V2_PRD_FIELD_MAP.compat_v1).toBe("migrated_from_v1");
    expect(MEMORY_V2_NOTES_EXTENSION_SQL_DRAFT).toMatch(
      /scope TEXT NOT NULL DEFAULT 'project'/,
    );
  });

  it("nao altera surface MCP de 12 tools", () => {
    expect(MCP_TOOL_NAMES).toHaveLength(12);
    expect(MCP_TOOL_NAMES).toContain("remember");
    expect(MCP_TOOL_NAMES).toContain("recall");
  });
});
