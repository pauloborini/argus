import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  defaultMemoryReadFilter,
  enrichTemporalSignals,
  isScopeReadable,
  isSupersededForDefaultRead,
  passesV2ReadFilter,
  type MemoryNoteV2Row,
} from "../../src/memory/memory-retrieval.js";
import { VaultEngine } from "../../src/memory/vault-engine.js";
import { initWorkspace } from "../../src/workspace/workspace.js";

describe("memory retrieval v2 read filters (S05 T01)", () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  function root(): string {
    tempDir = mkdtempSync(join(tmpdir(), "argus-retrieval-v2-"));
    initWorkspace(tempDir);
    return tempDir;
  }

  function noteRow(overrides: Partial<MemoryNoteV2Row> = {}): MemoryNoteV2Row {
    return {
      note_id: "abc123def4567890",
      path: "decision/test.md",
      title: "Test",
      type: "decision",
      content: "conteudo",
      scope: "project",
      source: "direct_capture",
      confidence: "confirmed",
      observed_at: "2026-01-01T00:00:00.000Z",
      valid_from: null,
      valid_until: null,
      superseded_by: null,
      supersedes: null,
      stale_reason: null,
      contradiction_reason: null,
      ...overrides,
    };
  }

  it("org scope não é legível no filtro padrão", () => {
    expect(isScopeReadable("org", defaultMemoryReadFilter())).toBe(false);
    expect(passesV2ReadFilter(noteRow({ scope: "org" }))).toBe(false);
  });

  it("fato superseded é excluído da leitura padrão", () => {
    expect(isSupersededForDefaultRead(noteRow({ superseded_by: "current-id" }))).toBe(true);
    expect(passesV2ReadFilter(noteRow({ superseded_by: "current-id" }))).toBe(false);
  });

  it("valid_until expirado enriquece stale_reason", () => {
    const enriched = enrichTemporalSignals(
      noteRow({ valid_until: "2020-01-01T00:00:00.000Z" }),
      new Date("2026-01-01T00:00:00.000Z"),
    );
    expect(enriched.stale_reason).toBe("valid_until_expired");
  });

  it("valid_from futuro bloqueia leitura", () => {
    expect(
      passesV2ReadFilter(
        noteRow({ valid_from: "2099-01-01T00:00:00.000Z" }),
        { asOf: "2026-01-01T00:00:00.000Z" },
      ),
    ).toBe(false);
  });

  it("recall exclui org e superseded; vigente vence", async () => {
    const cwd = root();
    VaultEngine.init(cwd);
    const vault = join(cwd, ".argus", "memory", "vault", "decision");
    mkdirSync(vault, { recursive: true });

    writeFileSync(
      join(vault, "vigente.md"),
      [
        "---",
        'title: "Billing vigente"',
        "type: decision",
        "scope: project",
        "source: direct_capture",
        "confidence: confirmed",
        "observed_at: 2026-01-01T00:00:00.000Z",
        "---",
        "",
        "billing invoice payment",
        "",
      ].join("\n"),
      "utf-8",
    );
    writeFileSync(
      join(vault, "superseded.md"),
      [
        "---",
        'title: "Billing antigo"',
        "type: decision",
        "scope: project",
        "source: direct_capture",
        "confidence: presumed",
        "observed_at: 2025-01-01T00:00:00.000Z",
        "superseded_by: fb00000000000001",
        "---",
        "",
        "billing invoice legacy",
        "",
      ].join("\n"),
      "utf-8",
    );
    writeFileSync(
      join(vault, "org-note.md"),
      [
        "---",
        'title: "Org secret"',
        "type: decision",
        "scope: org",
        "source: direct_capture",
        "confidence: confirmed",
        "observed_at: 2026-01-01T00:00:00.000Z",
        "---",
        "",
        "billing org only",
        "",
      ].join("\n"),
      "utf-8",
    );
    expect(VaultEngine.sync(cwd).state).toBe("sucesso");

    const recalled = await VaultEngine.recall("billing", { limit: 10 }, cwd);
    const titles = recalled.chunks.map((chunk) => chunk.title);
    expect(titles).toContain("Billing vigente");
    expect(titles).not.toContain("Billing antigo");
    expect(titles).not.toContain("Org secret");
    expect(recalled.chunks.every((chunk) => chunk.mechanism)).toBe(true);
  });

  it("stale_reason e contradiction_reason chegam ao chunk", async () => {
    const cwd = root();
    VaultEngine.init(cwd);
    const vault = join(cwd, ".argus", "memory", "vault", "inbox");
    mkdirSync(vault, { recursive: true });
    writeFileSync(
      join(vault, "stale.md"),
      [
        "---",
        'title: "Stale fact"',
        "type: inbox",
        "scope: project",
        "source: direct_capture",
        "confidence: inferred",
        "observed_at: 2026-01-01T00:00:00.000Z",
        'stale_reason: "session_expired"',
        'contradiction_reason: "conflicting_values_same_scope"',
        "---",
        "",
        "token stale fact unique",
        "",
      ].join("\n"),
      "utf-8",
    );
    expect(VaultEngine.sync(cwd).state).toBe("sucesso");

    const recalled = await VaultEngine.recall("token stale", { limit: 5 }, cwd);
    expect(recalled.state).toBe("parcial");
    expect(recalled.chunks[0]?.stale_reason).toBe("session_expired");
    expect(recalled.chunks[0]?.contradiction_reason).toBe("conflicting_values_same_scope");
    expect(recalled.chunks[0]?.mechanism).toBe("fts-only");
  });
});
