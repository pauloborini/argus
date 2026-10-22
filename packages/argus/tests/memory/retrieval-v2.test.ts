import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyV2RankingFactors,
  buildV2ReadSqlFilter,
  defaultMemoryReadFilter,
  enrichTemporalSignals,
  isScopeReadable,
  isSupersededForDefaultRead,
  MEMORY_V2_RANKING_WEIGHTS,
  passesV2ReadFilter,
  rerankChunksWithV2Factors,
  type MemoryNoteV2Row,
} from "../../src/memory/memory-retrieval.js";
import { VaultEngine } from "../../src/memory/vault-engine.js";
import { initWorkspace } from "../../src/workspace/workspace.js";
import { FakeEmbedder } from "../../src/embeddings/embedder.js";
import { buildRecallResponse, buildRecallResponseAsync } from "../../src/mcp/tools/recall.js";
import { openMemoryDb, closeMemoryDb } from "../../src/memory/storage/sqlite-db.js";
import { TOOL_INPUT_SCHEMAS } from "../../src/mcp/server.js";

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

  it("filtro SQL inclui source antes do ranking", () => {
    const filter = buildV2ReadSqlFilter({ sources: ["direct_capture"], asOf: "2026-01-01T00:00:00.000Z" });

    expect(filter.clause).toContain("n.source IN (?)");
    expect(filter.params).toEqual(["project", "user", "session", "agent", "2026-01-01T00:00:00.000Z", "direct_capture"]);
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
        "scope: project",
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
    const { openMemoryDb, closeMemoryDb } = await import("../../src/memory/storage/sqlite-db.js");
    const orgDb = openMemoryDb(cwd);
    try {
      orgDb.prepare("UPDATE notes SET scope = 'org' WHERE path = ?").run("decision/org-note.md");
    } finally {
      closeMemoryDb(orgDb);
    }

    const recalled = await VaultEngine.recall("billing", { limit: 10 }, cwd);
    const titles = recalled.chunks.map((chunk) => chunk.title);
    expect(titles).toContain("Billing vigente");
    expect(titles).not.toContain("Billing antigo");
    expect(titles).not.toContain("Org secret");
    expect(recalled.chunks.every((chunk) => chunk.mechanism)).toBe(true);
  });

  it("valid_from futuro bloqueia leitura via SQL com asOf", async () => {
    const cwd = root();
    VaultEngine.init(cwd);
    const vault = join(cwd, ".argus", "memory", "vault", "inbox");
    mkdirSync(vault, { recursive: true });
    writeFileSync(
      join(vault, "future.md"),
      [
        "---",
        'title: "Future fact"',
        "type: inbox",
        "scope: project",
        "source: direct_capture",
        "confidence: confirmed",
        "observed_at: 2026-01-01T00:00:00.000Z",
        "valid_from: 2099-06-01T00:00:00.000Z",
        "---",
        "",
        "future token unique",
        "",
      ].join("\n"),
      "utf-8",
    );
    expect(VaultEngine.sync(cwd).state).toBe("sucesso");
    const recalled = await VaultEngine.recall("future token", { limit: 5 }, cwd);
    expect(recalled.chunks).toHaveLength(0);
  });

  it("dense usa só notas legíveis antes do RRF", async () => {
    const cwd = root();
    VaultEngine.init(cwd);
    const vault = join(cwd, ".argus", "memory", "vault", "inbox");
    mkdirSync(vault, { recursive: true });
    for (let index = 0; index < 60; index += 1) {
      writeFileSync(
        join(vault, `invalid-${index}.md`),
        [
          "---",
          `title: "Invalid ${index}"`,
          "type: inbox",
          "scope: project",
          "source: direct_capture",
          "confidence: confirmed",
          "observed_at: 2026-01-01T00:00:00.000Z",
          "---",
          "",
          "alpha beta gamma hidden",
          "",
        ].join("\n"),
        "utf-8",
      );
    }
    writeFileSync(
      join(vault, "valid.md"),
      [
        "---",
        'title: "Valid visible"',
        "type: inbox",
        "scope: project",
        "source: direct_capture",
        "confidence: confirmed",
        "observed_at: 2026-01-01T00:00:00.000Z",
        "---",
        "",
        "alpha visible",
        "",
      ].join("\n"),
      "utf-8",
    );
    expect(VaultEngine.sync(cwd).state).toBe("sucesso");
    expect((await VaultEngine.embed(cwd, new FakeEmbedder())).state).toBe("sucesso");

    const { openMemoryDb, closeMemoryDb } = await import("../../src/memory/storage/sqlite-db.js");
    const db = openMemoryDb(cwd);
    try {
      db.prepare("UPDATE notes SET scope = 'org' WHERE path LIKE 'inbox/invalid-%'").run();
    } finally {
      closeMemoryDb(db);
    }

    const recalled = await VaultEngine.recall("alpha beta gamma", { limit: 1 }, cwd, new FakeEmbedder());
    expect(recalled.mechanism).toBe("hybrid-rrf");
    expect(recalled.chunks.map((chunk) => chunk.title)).toEqual(["Valid visible"]);
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
    expect(recalled.chunks[0]?.rank_reason).toMatch(/stale:session_expired/);
    expect(recalled.chunks[0]?.rank_reason).toMatch(/contradiction:/);
  });
});

describe("memory ranking v2 factors (S06 / Plano 4)", () => {
  it("AC-4.2.1 relevância-base controlada: confirmed > inferred > presumed", () => {
    const asOf = new Date("2026-07-01T00:00:00.000Z");
    const observed = "2026-07-01T00:00:00.000Z";
    const base = 1;
    const confirmed = applyV2RankingFactors(
      base,
      { confidence: "confirmed", observed_at: observed, stale_reason: null, contradiction_reason: null },
      asOf,
    );
    const inferred = applyV2RankingFactors(
      base,
      { confidence: "inferred", observed_at: observed, stale_reason: null, contradiction_reason: null },
      asOf,
    );
    const presumed = applyV2RankingFactors(
      base,
      { confidence: "presumed", observed_at: observed, stale_reason: null, contradiction_reason: null },
      asOf,
    );
    expect(confirmed.score).toBeGreaterThan(inferred.score);
    expect(inferred.score).toBeGreaterThan(presumed.score);
    expect(confirmed.factors.confidence).toBe(MEMORY_V2_RANKING_WEIGHTS.confidence.confirmed);
    expect(inferred.factors.confidence).toBe(MEMORY_V2_RANKING_WEIGHTS.confidence.inferred);
    expect(presumed.factors.confidence).toBe(MEMORY_V2_RANKING_WEIGHTS.confidence.presumed);
  });

  it("AC-4.2.2 stale e contradiction ficam abaixo de saudável e carregam motivo", () => {
    const asOf = new Date("2026-07-01T00:00:00.000Z");
    const observed = "2026-07-01T00:00:00.000Z";
    const healthy = applyV2RankingFactors(
      1,
      { confidence: "presumed", observed_at: observed, stale_reason: null, contradiction_reason: null },
      asOf,
    );
    const stale = applyV2RankingFactors(
      1,
      {
        confidence: "confirmed",
        observed_at: observed,
        stale_reason: "session_expired",
        contradiction_reason: null,
      },
      asOf,
    );
    const contradiction = applyV2RankingFactors(
      1,
      {
        confidence: "confirmed",
        observed_at: observed,
        stale_reason: null,
        contradiction_reason: "conflicting_values_same_scope",
      },
      asOf,
    );
    expect(stale.score).toBeLessThan(healthy.score);
    expect(contradiction.score).toBeLessThan(healthy.score);
    expect(stale.rank_reason).toContain("stale:session_expired");
    expect(contradiction.rank_reason).toContain("contradiction:conflicting_values_same_scope");
    expect(stale.factors.stale).toBe(MEMORY_V2_RANKING_WEIGHTS.stale);
    expect(contradiction.factors.contradiction).toBe(MEMORY_V2_RANKING_WEIGHTS.contradiction);
  });

  it("AC-4.2.3 fato antigo confirmado recuperável; recência tem piso", () => {
    const asOf = new Date("2026-07-01T00:00:00.000Z");
    const ancientConfirmed = applyV2RankingFactors(
      1,
      {
        confidence: "confirmed",
        observed_at: "2018-01-01T00:00:00.000Z",
        stale_reason: null,
        contradiction_reason: null,
      },
      asOf,
    );
    const freshPresumed = applyV2RankingFactors(
      1,
      {
        confidence: "presumed",
        observed_at: "2026-07-01T00:00:00.000Z",
        stale_reason: null,
        contradiction_reason: null,
      },
      asOf,
    );
    expect(ancientConfirmed.factors.recency).toBe(MEMORY_V2_RANKING_WEIGHTS.recency.floor);
    expect(ancientConfirmed.score).toBeGreaterThan(0);
    // confirmed*floor (1.2*0.7=0.84) > presumed*fresh (1.0*1.0=1.0)? 0.84 < 1.0
    // Lexical base still matters: with equal base, fresh presumed can outrank ancient confirmed
    // via recency — but floor prevents wipe. Prove floor + non-zero + confirmed still beats
    // ancient presumed with same age.
    const ancientPresumed = applyV2RankingFactors(
      1,
      {
        confidence: "presumed",
        observed_at: "2018-01-01T00:00:00.000Z",
        stale_reason: null,
        contradiction_reason: null,
      },
      asOf,
    );
    expect(ancientConfirmed.score).toBeGreaterThan(ancientPresumed.score);
    expect(ancientConfirmed.score).toBeGreaterThanOrEqual(
      MEMORY_V2_RANKING_WEIGHTS.confidence.confirmed * MEMORY_V2_RANKING_WEIGHTS.recency.floor - 1e-9,
    );
    // Recência não zera: score antigo confirmado ≥ piso * confidence
    expect(freshPresumed.factors.recency).toBeGreaterThan(ancientConfirmed.factors.recency - 1e-9);
  });

  it("rerankChunksWithV2Factors ordena por score v2 sem semear resultado final", () => {
    const asOf = new Date("2026-07-01T00:00:00.000Z");
    const ranked = rerankChunksWithV2Factors(
      [
        {
          note_id: "a",
          path: "a.md",
          title: "Presumed",
          type: "inbox",
          score: 1,
          snippet: "x",
          mechanism: "fts-only",
          confidence: "presumed",
          observed_at: "2026-07-01T00:00:00.000Z",
        },
        {
          note_id: "b",
          path: "b.md",
          title: "Confirmed",
          type: "inbox",
          score: 1,
          snippet: "x",
          mechanism: "fts-only",
          confidence: "confirmed",
          observed_at: "2026-07-01T00:00:00.000Z",
        },
        {
          note_id: "c",
          path: "c.md",
          title: "Stale",
          type: "inbox",
          score: 1,
          snippet: "x",
          mechanism: "fts-only",
          confidence: "confirmed",
          observed_at: "2026-07-01T00:00:00.000Z",
          stale_reason: "session_expired",
        },
      ],
      asOf,
    );
    expect(ranked.map((c) => c.title)).toEqual(["Confirmed", "Presumed", "Stale"]);
  });
});

describe("S6 ranking via recall em banco real", () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  function root(): string {
    tempDir = mkdtempSync(join(tmpdir(), "argus-rank-s6-"));
    initWorkspace(tempDir);
    return tempDir;
  }

  it("AC-4.2.1/2 recall: confirmed>inferred>presumed; superseded ausente; stale/contradiction abaixo", async () => {
    const cwd = root();
    VaultEngine.init(cwd);
    const vault = join(cwd, ".argus", "memory", "vault", "decision");
    mkdirSync(vault, { recursive: true });
    const body = "rankingtoken shared body identical for bm25 parity";
    const peers: Array<{ file: string; title: string; extra: string[] }> = [
      { file: "confirmed.md", title: "Confirmed peer", extra: ["confidence: confirmed"] },
      { file: "inferred.md", title: "Inferred peer", extra: ["confidence: inferred"] },
      { file: "presumed.md", title: "Presumed peer", extra: ["confidence: presumed"] },
      {
        file: "stale.md",
        title: "Stale peer",
        extra: ["confidence: confirmed", 'stale_reason: "session_expired"'],
      },
      {
        file: "contradiction.md",
        title: "Contradiction peer",
        extra: ["confidence: confirmed", 'contradiction_reason: "conflicting_values_same_scope"'],
      },
      {
        file: "superseded.md",
        title: "Superseded peer",
        extra: ["confidence: confirmed", "superseded_by: deadbeefdeadbeef"],
      },
    ];
    for (const peer of peers) {
      writeFileSync(
        join(vault, peer.file),
        [
          "---",
          `title: ${JSON.stringify(peer.title)}`,
          "type: decision",
          "scope: project",
          "source: direct_capture",
          ...peer.extra,
          "observed_at: 2026-06-01T00:00:00.000Z",
          "---",
          "",
          body,
          "",
        ].join("\n"),
        "utf-8",
      );
    }
    expect(VaultEngine.sync(cwd).state).toBe("sucesso");

    const recalled = await VaultEngine.recall("rankingtoken", { limit: 10 }, cwd);
    const titles = recalled.chunks.map((c) => c.title);
    expect(titles).not.toContain("Superseded peer");
    expect(titles).toContain("Confirmed peer");
    expect(titles).toContain("Inferred peer");
    expect(titles).toContain("Presumed peer");
    expect(titles).toContain("Stale peer");
    expect(titles).toContain("Contradiction peer");
    const confirmedIdx = titles.indexOf("Confirmed peer");
    const inferredIdx = titles.indexOf("Inferred peer");
    const presumedIdx = titles.indexOf("Presumed peer");
    const staleIdx = titles.indexOf("Stale peer");
    const contradictionIdx = titles.indexOf("Contradiction peer");
    expect(confirmedIdx).toBeLessThan(inferredIdx);
    expect(inferredIdx).toBeLessThan(presumedIdx);
    expect(presumedIdx).toBeLessThan(staleIdx);
    expect(presumedIdx).toBeLessThan(contradictionIdx);
    expect(recalled.chunks[staleIdx]?.rank_reason).toMatch(/stale:session_expired/);
    expect(recalled.chunks[contradictionIdx]?.rank_reason).toMatch(/contradiction:/);
    expect(recalled.state).toBe("parcial");
  });

  it("AC-4.2.3 recall: antigo confirmed permanece recuperável com piso de recência", async () => {
    const cwd = root();
    VaultEngine.init(cwd);
    const vault = join(cwd, ".argus", "memory", "vault", "decision");
    mkdirSync(vault, { recursive: true });
    const body = "ancienttoken shared body for recency floor";
    writeFileSync(
      join(vault, "ancient-confirmed.md"),
      [
        "---",
        'title: "Ancient confirmed"',
        "type: decision",
        "scope: project",
        "source: direct_capture",
        "confidence: confirmed",
        "observed_at: 2018-01-01T00:00:00.000Z",
        "---",
        "",
        body,
        "",
      ].join("\n"),
      "utf-8",
    );
    writeFileSync(
      join(vault, "ancient-presumed.md"),
      [
        "---",
        'title: "Ancient presumed"',
        "type: decision",
        "scope: project",
        "source: direct_capture",
        "confidence: presumed",
        "observed_at: 2018-01-01T00:00:00.000Z",
        "---",
        "",
        body,
        "",
      ].join("\n"),
      "utf-8",
    );
    expect(VaultEngine.sync(cwd).state).toBe("sucesso");

    const recalled = await VaultEngine.recall("ancienttoken", { limit: 10 }, cwd);
    const titles = recalled.chunks.map((c) => c.title);
    expect(titles).toContain("Ancient confirmed");
    expect(titles).toContain("Ancient presumed");
    const confirmed = recalled.chunks.find((c) => c.title === "Ancient confirmed");
    const presumed = recalled.chunks.find((c) => c.title === "Ancient presumed");
    expect(confirmed?.rank_reason).toMatch(/recency:floor/);
    expect(confirmed!.score).toBeGreaterThan(0);
    expect(confirmed!.score).toBeGreaterThan(presumed!.score);
    expect(titles.indexOf("Ancient confirmed")).toBeLessThan(titles.indexOf("Ancient presumed"));
  });

  it("AC-5.1.2 remember real: confirmed (decision) precede presumed (inbox) no recall", async () => {
    const cwd = root();
    const token = "rankpeerbodyidenticalfortsparity";
    const body = `${token} shared body identical for bm25 parity`;

    const confirmed = await VaultEngine.remember(body, { type: "decision", tags: ["rank-peer"] }, cwd);
    const presumed = await VaultEngine.remember(body, { type: "inbox", tags: ["rank-peer"] }, cwd);
    expect(confirmed.state).toBe("sucesso");
    expect(presumed.state).toBe("sucesso");
    expect(confirmed.note_id).not.toBe(presumed.note_id);

    const recalled = await VaultEngine.recall(token, { limit: 10 }, cwd);
    const chunks = recalled.chunks.filter(
      (c) => c.note_id === confirmed.note_id || c.note_id === presumed.note_id,
    );
    expect(chunks).toHaveLength(2);

    const confirmedChunk = chunks.find((c) => c.note_id === confirmed.note_id)!;
    const presumedChunk = chunks.find((c) => c.note_id === presumed.note_id)!;
    expect(confirmedChunk.confidence).toBe("confirmed");
    expect(presumedChunk.confidence).toBe("presumed");
    expect(confirmedChunk.rank_factors?.confidence).toBe(
      MEMORY_V2_RANKING_WEIGHTS.confidence.confirmed,
    );
    expect(presumedChunk.rank_factors?.confidence).toBe(
      MEMORY_V2_RANKING_WEIGHTS.confidence.presumed,
    );
    expect(confirmedChunk.rank_reason).toMatch(/^confirmed;/);
    expect(presumedChunk.rank_reason).toMatch(/^presumed;/);
    expect(confirmedChunk.score).toBeGreaterThan(presumedChunk.score);

    const titles = recalled.chunks.map((c) => c.note_id);
    expect(titles.indexOf(confirmed.note_id)).toBeLessThan(titles.indexOf(presumed.note_id));
  });

  describe("MEMORY-ASOF-001 — as_of no recall MCP e repasse ao motor v2", () => {
    it("§7.1 nota com valid_from futuro: as_of anterior à vigência não traz a nota; sem as_of ou posterior traz (sync e async, com offset)", async () => {
      const cwd = root();
      VaultEngine.init(cwd);
      const vault = join(cwd, ".argus", "memory", "vault", "inbox");
      mkdirSync(vault, { recursive: true });

      writeFileSync(
        join(vault, "future.md"),
        [
          "---",
          'title: "Future Billing Feature"',
          "type: inbox",
          "scope: project",
          "source: direct_capture",
          "confidence: confirmed",
          "observed_at: 2026-01-01T00:00:00.000Z",
          "valid_from: 2026-06-01T00:00:00.000Z",
          "---",
          "",
          "billing_feature_token_unique next generation payments",
          "",
        ].join("\n"),
        "utf-8",
      );

      writeFileSync(
        join(vault, "active.md"),
        [
          "---",
          'title: "Active Billing Feature"',
          "type: inbox",
          "scope: project",
          "source: direct_capture",
          "confidence: confirmed",
          "observed_at: 2026-01-01T00:00:00.000Z",
          "valid_from: 2026-01-01T00:00:00.000Z",
          "---",
          "",
          "billing_feature_token_unique legacy stable payments",
          "",
        ].join("\n"),
        "utf-8",
      );

      expect(VaultEngine.sync(cwd).state).toBe("sucesso");

      // 1. Sync path: VaultEngine.search com asOf anterior à vigência (2026-03-01)
      const syncPast = VaultEngine.search("billing_feature_token_unique", { asOf: "2026-03-01T00:00:00.000Z" }, cwd);
      const syncPastTitles = syncPast.chunks.map((c) => c.title);
      expect(syncPastTitles).toContain("Active Billing Feature");
      expect(syncPastTitles).not.toContain("Future Billing Feature");

      // 2. Sync path: VaultEngine.search com asOf posterior à vigência (2026-07-01)
      const syncFuture = VaultEngine.search("billing_feature_token_unique", { asOf: "2026-07-01T00:00:00.000Z" }, cwd);
      const syncFutureTitles = syncFuture.chunks.map((c) => c.title);
      expect(syncFutureTitles).toContain("Active Billing Feature");
      expect(syncFutureTitles).toContain("Future Billing Feature");

      // 3. Sync path: VaultEngine.search com offset de timezone explícito (Risco 2)
      // 2026-07-01T03:00:00-03:00 é 2026-07-01T06:00:00.000Z, posterior a 2026-06-01
      const syncOffset = VaultEngine.search("billing_feature_token_unique", { asOf: "2026-07-01T03:00:00-03:00" }, cwd);
      expect(syncOffset.chunks.map((c) => c.title)).toContain("Future Billing Feature");

      // 4. Async path: VaultEngine.recall com asOf anterior e posterior
      const asyncPast = await VaultEngine.recall("billing_feature_token_unique", { asOf: "2026-03-01T00:00:00.000Z" }, cwd);
      expect(asyncPast.chunks.map((c) => c.title)).not.toContain("Future Billing Feature");
      expect(asyncPast.chunks.map((c) => c.title)).toContain("Active Billing Feature");

      const asyncFuture = await VaultEngine.recall("billing_feature_token_unique", { asOf: "2026-07-01T00:00:00.000Z" }, cwd);
      expect(asyncFuture.chunks.map((c) => c.title)).toContain("Future Billing Feature");
      expect(asyncFuture.chunks.map((c) => c.title)).toContain("Active Billing Feature");

      // 5. Sem asOf: comportamento padrão (now é 2026-09+, posterior a 2026-06-01) traz ambas
      const semAsOf = await VaultEngine.recall("billing_feature_token_unique", {}, cwd);
      expect(semAsOf.chunks.map((c) => c.title)).toContain("Future Billing Feature");
      expect(semAsOf.chunks.map((c) => c.title)).toContain("Active Billing Feature");

      // 6. buildRecallResponse e buildRecallResponseAsync repassam as_of
      const toolSyncPast = buildRecallResponse(cwd, { query: "billing_feature_token_unique", as_of: "2026-03-01T00:00:00.000Z" });
      const chunksSync = (toolSyncPast.chunks ?? []) as Array<{ title?: string }>;
      expect(chunksSync.map((c) => c.title)).not.toContain("Future Billing Feature");

      const toolAsyncPast = await buildRecallResponseAsync(cwd, { query: "billing_feature_token_unique", as_of: "2026-03-01T00:00:00.000Z" });
      const chunksAsync = (toolAsyncPast.chunks ?? []) as Array<{ title?: string }>;
      expect(chunksAsync.map((c) => c.title)).not.toContain("Future Billing Feature");
    });

    it("§7.2 nota supersedida antes de as_of é excluída mas permanece auditável no SQLite", async () => {
      const cwd = root();
      VaultEngine.init(cwd);
      const vault = join(cwd, ".argus", "memory", "vault", "decision");
      mkdirSync(vault, { recursive: true });

      writeFileSync(
        join(vault, "origin_superseded.md"),
        [
          "---",
          'title: "Auth Origin Note"',
          "type: decision",
          "scope: project",
          "source: direct_capture",
          "confidence: presumed",
          "observed_at: 2025-01-01T00:00:00.000Z",
          "superseded_by: fb00000000000002",
          "---",
          "",
          "auth_unique_token_asof legacy cookie auth",
          "",
        ].join("\n"),
        "utf-8",
      );

      writeFileSync(
        join(vault, "successor_active.md"),
        [
          "---",
          'title: "Auth Successor Note"',
          "type: decision",
          "scope: project",
          "source: direct_capture",
          "confidence: confirmed",
          "observed_at: 2026-01-01T00:00:00.000Z",
          "---",
          "",
          "auth_unique_token_asof modern bearer auth",
          "",
        ].join("\n"),
        "utf-8",
      );

      expect(VaultEngine.sync(cwd).state).toBe("sucesso");

      // Recall com as_of posterior não traz a supersedida
      const recalled = await VaultEngine.recall(
        "auth_unique_token_asof",
        { asOf: "2026-06-01T00:00:00.000Z" },
        cwd,
      );
      const titles = recalled.chunks.map((c) => c.title);
      expect(titles).toContain("Auth Successor Note");
      expect(titles).not.toContain("Auth Origin Note");

      // Invariante DEC-021: a nota supersedida continua no SQLite para auditoria (não foi deletada)
      const db = openMemoryDb(cwd);
      try {
        const rows = db.prepare("SELECT title, superseded_by FROM notes WHERE title = ?").all("Auth Origin Note") as Array<{ title: string; superseded_by: string }>;
        expect(rows).toHaveLength(1);
        expect(rows[0]!.superseded_by).toBe("fb00000000000002");
      } finally {
        closeMemoryDb(db);
      }
    });

    it("§7.3 validação de as_of: rejeita data inválida com E_MEMORY_INPUT_INVALID e aceita ISO 8601 válido", async () => {
      const cwd = root();

      // Formato inválido sync
      const invalidSync = buildRecallResponse(cwd, { query: "billing", as_of: "nao-e-uma-data" });
      expect(invalidSync.state).toBe("falha");
      expect(invalidSync.message).toBe("E_MEMORY_INPUT_INVALID: as_of precisa ser ISO 8601.");
      expect(invalidSync.chunks).toEqual([]);
      expect(invalidSync.mechanism).toBe("fts-only");
      expect(invalidSync.confidence).toBe("low");

      // Formato inválido async
      const invalidAsync = await buildRecallResponseAsync(cwd, { query: "billing", as_of: "nao-e-uma-data" });
      expect(invalidAsync.state).toBe("falha");
      expect(invalidAsync.message).toBe("E_MEMORY_INPUT_INVALID: as_of precisa ser ISO 8601.");
      expect(invalidAsync.chunks).toEqual([]);
      expect(invalidAsync.confidence).toBe("low");

      // ISO válido é aceito na validação
      const validSync = buildRecallResponse(cwd, { query: "billing", as_of: "2026-06-01T00:00:00.000Z" });
      expect(validSync.message).not.toContain("E_MEMORY_INPUT_INVALID");

      const validOffset = buildRecallResponse(cwd, { query: "billing", as_of: "2026-06-01T03:00:00-03:00" });
      expect(validOffset.message).not.toContain("E_MEMORY_INPUT_INVALID");

      // Schema do MCP aceita as_of com max 32
      const parsed = TOOL_INPUT_SCHEMAS.recall.parse({
        query: "billing",
        as_of: "2026-06-01T00:00:00.000Z",
      });
      expect(parsed.as_of).toBe("2026-06-01T00:00:00.000Z");

      const tooLong = TOOL_INPUT_SCHEMAS.recall.safeParse({
        query: "billing",
        as_of: "2026-06-01T00:00:00.000Z" + "a".repeat(20),
      });
      expect(tooLong.success).toBe(false);
    });
  });
});
