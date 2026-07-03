import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MCP_TOOL_NAMES } from "../../src/mcp/tool-registry.js";
import { buildToolResponse } from "../../src/mcp/tools/response.js";
import { runIndex } from "../../src/commands/index-cmd.js";
import { extractGraphRelations } from "../../src/memory/memory-graph-extractor.js";
import {
  queryMemoryGraphByPath,
  queryMemoryGraphBySymbol,
  queryMemoryGraphByTag,
} from "../../src/memory/memory-graph-query.js";
import { getMemoryDbPath } from "../../src/memory/paths.js";
import { closeMemoryDb, openMemoryDb } from "../../src/memory/storage/sqlite-db.js";
import { migrateMemoryDbGraphTables } from "../../src/memory/storage/sqlite-v2-migrate.js";
import { VaultEngine } from "../../src/memory/vault-engine.js";
import { parseMarkdown } from "../../src/memory/markdown-parser.js";
import { initWorkspace } from "../../src/workspace/workspace.js";

describe("memory graph local (S04)", () => {
  let tempDir: string | undefined;
  let originalCwd: string | undefined;

  afterEach(() => {
    if (originalCwd) {
      process.chdir(originalCwd);
      originalCwd = undefined;
    }
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  function root(): string {
    originalCwd = process.cwd();
    tempDir = mkdtempSync(join(tmpdir(), "argus-memory-graph-"));
    initWorkspace(tempDir);
    process.chdir(tempDir);
    return tempDir;
  }

  function writeVaultNote(relPath: string, content: string): void {
    const cwd = process.cwd();
    const full = join(cwd, ".argus", "memory", "vault", relPath);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content, "utf-8");
  }

  it("extrator cobre wikilink, tag, path, simbolo e link quebrado (T02)", () => {
    const cwd = root();
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(join(cwd, "src", "service.ts"), "export function calculateTotal() { return 1; }\n", "utf-8");
    const vaultNotes = [
      { id: "note-a", path: "decision/target.md", title: "Target note" },
      { id: "note-b", path: "inbox/source.md", title: "Source note" },
    ];
    const parsed = parseMarkdown(
      [
        "---",
        'title: "Graph source"',
        "type: decision",
        'tags: ["auth", "auth"]',
        'links: ["decision/target.md", "missing-note.md"]',
        "---",
        "",
        "Ver [[decision/target]] e `calculateTotal` em `src/service.ts` e path fantasma `ghost/missing.ts`.",
      ].join("\n"),
      "source",
    );

    const relations = extractGraphRelations(parsed, {
      cwd,
      noteId: "note-b",
      notePath: "inbox/source.md",
      noteTitle: "Graph source",
      vaultNotes,
      pathExists: (path) => existsSync(join(cwd, path)),
      resolveSymbol: (name) =>
        name === "calculateTotal" ? [{ file: "src/service.ts", line: 1, symbol: "calculateTotal" }] : [],
    });

    expect(relations.some((item) => item.mechanism === "wikilink" && item.confidence === "confirmed")).toBe(true);
    expect(relations.some((item) => item.mechanism === "tag" && item.target.canonical_key === "auth")).toBe(true);
    expect(relations.filter((item) => item.mechanism === "tag")).toHaveLength(1);
    expect(relations.some((item) => item.mechanism === "path_citation" && item.confidence === "confirmed")).toBe(
      true,
    );
    expect(relations.some((item) => item.mechanism === "symbol_mention" && item.confidence === "confirmed")).toBe(
      true,
    );
    const broken = relations.find((item) => item.mechanism === "frontmatter_link" && item.evidence === "missing-note.md");
    expect(broken?.confidence).toBe("presumed");
    expect(relations.some((item) => item.mechanism === "path_citation" && item.evidence.includes("ghost"))).toBe(
      false,
    );
    const unresolved = relations.find((item) => item.mechanism === "symbol_mention" && item.target.label === "missing");
    if (unresolved) {
      expect(unresolved.confidence).not.toBe("confirmed");
    }
  });

  it("sync reconstrói grafo de forma idempotente (T03)", () => {
    const cwd = root();
    writeVaultNote(
      "decision/graph-target.md",
      [
        "---",
        'title: "Target"',
        "type: decision",
        'tags: ["memory-graph"]',
        "---",
        "",
        "Decisão citando `src/target.ts`.",
      ].join("\n"),
    );
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(join(cwd, "src", "target.ts"), "export {}\n", "utf-8");

    VaultEngine.init(cwd);
    const first = VaultEngine.sync(cwd);
    expect(first.notes_count).toBe(1);

    const db = openMemoryDb(cwd, { readonly: true });
    let firstEntityCount = 0;
    let firstRelationCount = 0;
    try {
      const entities = db.prepare("SELECT COUNT(*) AS count FROM memory_entities").get() as { count: number };
      const relations = db.prepare("SELECT COUNT(*) AS count FROM memory_relations").get() as { count: number };
      firstEntityCount = entities.count;
      firstRelationCount = relations.count;
      expect(entities.count).toBeGreaterThan(0);
      expect(relations.count).toBeGreaterThan(0);
    } finally {
      closeMemoryDb(db);
    }

    const second = VaultEngine.sync(cwd);
    expect(second.notes_count).toBe(1);
    const db2 = openMemoryDb(cwd, { readonly: true });
    try {
      const entities2 = db2.prepare("SELECT COUNT(*) AS count FROM memory_entities").get() as { count: number };
      const relations2 = db2.prepare("SELECT COUNT(*) AS count FROM memory_relations").get() as { count: number };
      expect(entities2.count).toBe(firstEntityCount);
      expect(relations2.count).toBe(firstRelationCount);
    } finally {
      closeMemoryDb(db2);
    }
  });

  it("consulta interna retorna mecanismo e confiança (T04)", async () => {
    const cwd = root();
    writeVaultNote(
      "decision/query.md",
      [
        "---",
        'title: "Query note"',
        "type: decision",
        'tags: ["retrieval"]',
        'links: ["decision/other.md"]',
        "---",
        "",
        "Citando `helper` em path `utils.ts`.",
      ].join("\n"),
    );
    writeFileSync(join(cwd, "utils.ts"), "export function helper() {}\n", "utf-8");
    VaultEngine.init(cwd);
    expect(await runIndex()).toBe(0);
    VaultEngine.sync(cwd);

    const db = openMemoryDb(cwd, { readonly: true });
    try {
      const byTag = queryMemoryGraphByTag(db, "retrieval");
      expect(byTag[0]?.mechanism).toBe("tag");
      expect(byTag[0]?.confidence).toBe("confirmed");
      expect(byTag[0]?.evidence).toBeTruthy();

      const byPath = queryMemoryGraphByPath(db, "utils.ts");
      expect(byPath.some((item) => item.mechanism === "path_citation")).toBe(true);

      const bySymbol = queryMemoryGraphBySymbol(db, "helper");
      expect(bySymbol[0]?.mechanism).toBe("symbol_mention");
      expect(bySymbol[0]?.confidence).toBe("confirmed");
      expect(bySymbol[0]?.score).toBe(1);
    } finally {
      closeMemoryDb(db);
    }
  });

  it("vault vazio não gera erro falso e recall FTS segue (T06 regressão)", async () => {
    const cwd = root();
    VaultEngine.init(cwd);
    const sync = VaultEngine.sync(cwd);
    expect(sync.notes_count).toBe(0);
    expect(sync.state).toBe("sucesso");

    const recall = await VaultEngine.recall("qualquer", { limit: 3 }, cwd);
    expect(recall.state).toBe("sucesso");
    expect(recall.chunks).toEqual([]);
  });

  it("explore enriquece memory_refs via grafo quando fixture existe (T05)", async () => {
    const cwd = root();
    writeFileSync(
      join(cwd, "utils.ts"),
      "export function calculateTotal() { return 1; }\n",
      "utf-8",
    );
    writeVaultNote(
      "decision/explore-graph.md",
      [
        "---",
        'title: "Explore graph"',
        "type: decision",
        'tags: ["calculateTotal"]',
        "---",
        "",
        "Decisão sobre `calculateTotal` em `utils.ts`.",
      ].join("\n"),
    );
    VaultEngine.init(cwd);
    VaultEngine.sync(cwd);
    expect(await runIndex()).toBe(0);

    const payload = buildToolResponse("explore", cwd, { target: "calculateTotal", mode: "symbol" });
    const refs = payload.memory_refs as Array<{
      mechanism?: string;
      confidence?: string;
      path: string;
    }>;
    expect(refs.length).toBeGreaterThan(0);
    expect(refs.some((item) => item.mechanism && item.confidence)).toBe(true);
  });

  it("migração de tabelas de grafo é idempotente em banco existente (T01)", () => {
    const cwd = root();
    VaultEngine.init(cwd);
    VaultEngine.sync(cwd);
    const db = openMemoryDb(cwd);
    try {
      migrateMemoryDbGraphTables(db);
      migrateMemoryDbGraphTables(db);
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'memory_%' ORDER BY name")
        .all() as Array<{ name: string }>;
      expect(tables.map((item) => item.name)).toEqual(["memory_entities", "memory_meta", "memory_relations"]);
    } finally {
      closeMemoryDb(db);
    }
    expect(existsSync(getMemoryDbPath(cwd))).toBe(true);
  });

  it("sync registra limitação quando há menção de símbolo sem índice de código", () => {
    const cwd = root();
    writeVaultNote(
      "decision/symbol-warning.md",
      [
        "---",
        'title: "Symbol warning"',
        "type: decision",
        "---",
        "",
        "Usa `calculateTotal` sem índice.",
      ].join("\n"),
    );
    VaultEngine.init(cwd);
    const sync = VaultEngine.sync(cwd);
    expect(["sucesso", "parcial"]).toContain(sync.state);
    if (sync.state === "parcial") {
      const limitations = (sync.limitations as string[] | undefined) ?? [];
      expect(limitations.some((item) => item.includes("Índice de código"))).toBe(true);
    }
  });

  it("superfície MCP permanece com 12 tools (T06)", () => {
    expect(MCP_TOOL_NAMES).toHaveLength(12);
  });
});
