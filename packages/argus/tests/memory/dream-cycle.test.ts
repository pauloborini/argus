import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MCP_TOOL_NAMES } from "../../src/mcp/tool-registry.js";
import type { DreamAction } from "../../src/memory/dream-engine.js";
import { DreamEngine } from "../../src/memory/dream-engine.js";
import { parseMarkdown } from "../../src/memory/markdown-parser.js";
import { VaultEngine } from "../../src/memory/vault-engine.js";
import { initWorkspace } from "../../src/workspace/workspace.js";

describe("memory dream cycle (S07)", () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  function root(): string {
    tempDir = mkdtempSync(join(tmpdir(), "argus-dream-s07-"));
    initWorkspace(tempDir);
    return tempDir;
  }

  function vault(cwd: string): string {
    return join(cwd, ".argus", "memory", "vault");
  }

  function writeNote(cwd: string, relPath: string, content: string): void {
    const full = join(vault(cwd), relPath);
    writeFileSync(full, content, "utf-8");
  }

  function latestReport(cwd: string): string {
    const reportsDir = join(vault(cwd), "reports");
    const files = readdirSync(reportsDir).filter((file) => file.startsWith("dream-report-"));
    return readFileSync(join(reportsDir, files.sort().at(-1)!), "utf-8");
  }

  function actions(result: Awaited<ReturnType<typeof DreamEngine.run>>, state: DreamAction["state"]): DreamAction[] {
    const key = `${state === "sugerida" ? "suggested" : state === "aplicada" ? "applied" : "blocked"}_actions` as const;
    return (result[key] as DreamAction[] | undefined) ?? [];
  }

  it("dry-run gera relatorio e payload sem mover inbox nem alterar supersedencia", async () => {
    const cwd = root();
    VaultEngine.init(cwd);
    writeNote(
      cwd,
      "inbox/decisao.md",
      "# Decisão\n\nDecisão: usar Argus memory.\n",
    );
    VaultEngine.sync(cwd);

    const inboxPath = join(vault(cwd), "inbox", "decisao.md");
    const before = readFileSync(inboxPath, "utf-8");
    const result = await DreamEngine.run(cwd, { dryRun: true });

    expect(result.state).toBe("sucesso");
    expect(existsSync(inboxPath)).toBe(true);
    expect(readFileSync(inboxPath, "utf-8")).toBe(before);
    expect(result.report_file).toMatch(/^reports\/dream-report-/);
    expect(actions(result, "sugerida").some((item) => item.category === "triagem")).toBe(true);
    expect(actions(result, "aplicada")).toHaveLength(0);
    expect(latestReport(cwd)).toContain("Modo: dry-run");
  });

  it("apply move nota classificavel e roda sync", async () => {
    const cwd = root();
    VaultEngine.init(cwd);
    writeNote(cwd, "inbox/decisao.md", "# Decisão\n\nDecisão: usar Argus memory.\n");
    VaultEngine.sync(cwd);

    const result = await DreamEngine.run(cwd);
    expect(result.state).toBe("sucesso");
    expect(existsSync(join(vault(cwd), "decisions", "decisao.md"))).toBe(true);
    expect(existsSync(join(vault(cwd), "inbox", "decisao.md"))).toBe(false);
    expect(actions(result, "aplicada").some((item) => item.category === "triagem")).toBe(true);
    expect(VaultEngine.sync(cwd).state).toBe("sucesso");
  });

  it("nota nao classificavel fica na inbox como bloqueada", async () => {
    const cwd = root();
    VaultEngine.init(cwd);
    writeNote(cwd, "inbox/sem-tag.md", "# Nota solta\n\nconteudo sem classificacao.\n");
    VaultEngine.sync(cwd);

    const result = await DreamEngine.run(cwd, { dryRun: true });
    expect(existsSync(join(vault(cwd), "inbox", "sem-tag.md"))).toBe(true);
    const blocked = actions(result, "bloqueada");
    expect(blocked.some((item) => item.reason === "classificacao_indeterminada")).toBe(true);
  });

  it("duplicata lexical aparece como sugerida com score", async () => {
    const cwd = root();
    VaultEngine.init(cwd);
    const body = "conteudo duplicado lexical para dream cycle s07 teste fixture";
    writeNote(cwd, "decisions/a.md", `# A\n\n${body}\n`);
    writeNote(cwd, "decisions/b.md", `# B\n\n${body}\n`);
    VaultEngine.sync(cwd);

    const result = await DreamEngine.run(cwd, { dryRun: true });
    const dup = actions(result, "sugerida").find((item) => item.category === "duplicata");
    expect(dup).toBeDefined();
    expect(dup?.mechanism).toBe("lexical");
    expect((dup?.score ?? 0) > 0.9).toBe(true);
  });

  it("duplicata via grafo aparece com mechanism graph_entity quando fixture tem relacao", async () => {
    const cwd = root();
    VaultEngine.init(cwd);
    const sharedTag = "dream-s07-graph-dup-tag";
    writeNote(
      cwd,
      "decisions/graph-a.md",
      ["---", "title: Graph A", "type: decision", `tags: ["${sharedTag}"]`, "---", "", "conteudo alfa exclusivo graph a"].join(
        "\n",
      ),
    );
    writeNote(
      cwd,
      "decisions/graph-b.md",
      ["---", "title: Graph B", "type: decision", `tags: ["${sharedTag}"]`, "---", "", "texto beta distinto graph b"].join(
        "\n",
      ),
    );
    VaultEngine.sync(cwd);

    const result = await DreamEngine.run(cwd, { dryRun: true });
    const dup = actions(result, "sugerida").find(
      (item) =>
        item.category === "duplicata" &&
        item.mechanism !== "lexical" &&
        item.sources.includes("decisions/graph-a.md") &&
        item.sources.includes("decisions/graph-b.md"),
    );
    expect(dup).toBeDefined();
    expect(["graph_entity", "tag", "path_overlap"]).toContain(dup?.mechanism);
  });

  it("candidato v2 seguro grava superseded_by/supersedes sem remover conteudo", async () => {
    const cwd = root();
    VaultEngine.init(cwd);
    const shared = "fato canonico supersessao dream s07 fixture unico";
    writeNote(
      cwd,
      "decisions/origem.md",
      ["---", "title: Origem", "type: decision", "scope: project", "---", "", shared].join("\n"),
    );
    writeNote(
      cwd,
      "decisions/vigente.md",
      ["---", "title: Vigente", "type: decision", "scope: project", "---", "", shared].join("\n"),
    );
    VaultEngine.sync(cwd);

    const result = await DreamEngine.run(cwd);
    const origin = readFileSync(join(vault(cwd), "decisions", "origem.md"), "utf-8");
    const current = readFileSync(join(vault(cwd), "decisions", "vigente.md"), "utf-8");
    expect(origin).toContain(shared);
    expect(current).toContain(shared);
    expect(parseMarkdown(origin, "origem.md").superseded_by).toBeTruthy();
    expect(parseMarkdown(current, "vigente.md").supersedes).toBeTruthy();
    expect(actions(result, "aplicada").some((item) => item.category === "supersedencia")).toBe(true);
  });

  it("contradiction_reason entra como bloqueada", async () => {
    const cwd = root();
    VaultEngine.init(cwd);
    writeNote(
      cwd,
      "decisions/conflito.md",
      [
        "---",
        "title: Conflito",
        "type: decision",
        "scope: project",
        "contradiction_reason: fatos incompativeis no mesmo escopo",
        "---",
        "",
        "conteudo conflitante",
      ].join("\n"),
    );
    VaultEngine.sync(cwd);

    const result = await DreamEngine.run(cwd, { dryRun: true });
    expect(
      actions(result, "bloqueada").some(
        (item) => item.category === "contradicao" && item.reason.includes("incompativeis"),
      ),
    ).toBe(true);
  });

  it("apply preserva contradiction_reason de nota triada da inbox", async () => {
    const cwd = root();
    VaultEngine.init(cwd);
    writeNote(
      cwd,
      "inbox/conflito.md",
      [
        "---",
        "title: Conflito",
        "type: inbox",
        "scope: project",
        "tags: [decision]",
        "contradiction_reason: conflito vivo",
        "---",
        "",
        "# Decisão",
        "conteudo conflitante",
      ].join("\n"),
    );
    VaultEngine.sync(cwd);

    const result = await DreamEngine.run(cwd);
    const moved = readFileSync(join(vault(cwd), "decisions", "conflito.md"), "utf-8");
    expect(result.state).toBe("parcial");
    expect(parseMarkdown(moved, "conflito.md").contradiction_reason).toBe("conflito vivo");
    expect(actions(result, "bloqueada").some((item) => item.category === "contradicao")).toBe(true);
  });

  it("grupo de supersedencia aplica no maximo uma mutacao por nota", async () => {
    const cwd = root();
    VaultEngine.init(cwd);
    const shared = "fato canonico supersessao dream s07 fixture unico cadeia tripla";
    for (const name of ["a", "b", "c"]) {
      writeNote(
        cwd,
        `decisions/${name}.md`,
        ["---", `title: ${name}`, "type: decision", "scope: project", "---", "", shared].join("\n"),
      );
    }
    VaultEngine.sync(cwd);

    const result = await DreamEngine.run(cwd);
    const appliedSupersedence = actions(result, "aplicada").filter((item) => item.category === "supersedencia");
    const suggestedSupersedence = actions(result, "sugerida").filter((item) => item.category === "supersedencia");
    const parsed = Object.fromEntries(
      ["a", "b", "c"].map((name) => [
        name,
        parseMarkdown(readFileSync(join(vault(cwd), "decisions", `${name}.md`), "utf-8"), `${name}.md`),
      ]),
    );

    expect(appliedSupersedence).toHaveLength(1);
    expect(suggestedSupersedence.length).toBeGreaterThanOrEqual(1);
    const superseded = Object.values(parsed).filter((note) => note.superseded_by);
    const current = Object.values(parsed).filter((note) => note.supersedes);
    expect(superseded).toHaveLength(1);
    expect(current).toHaveLength(1);
    expect(current[0]!.supersedes).toBeDefined();
    expect(superseded[0]!.superseded_by).toBeDefined();
  });

  it("arquivo ruim gera bloqueio localizado e processa nota boa", async () => {
    const cwd = root();
    VaultEngine.init(cwd);
    writeNote(cwd, "inbox/boa.md", "# Decisão\n\nnota boa para triagem.\n");
    VaultEngine.sync(cwd);
    const badPath = join(vault(cwd), "decisions", "ruim.md");
    writeFileSync(badPath, "# Ruim\n\nconteudo\n", "utf-8");
    chmodSync(badPath, 0o000);

    try {
      const result = await DreamEngine.run(cwd, { dryRun: true });
      expect(["sucesso", "parcial"]).toContain(result.state);
      expect(actions(result, "bloqueada").some((item) => item.reason.includes("arquivo_ilegivel"))).toBe(true);
      expect(actions(result, "sugerida").some((item) => item.sources.includes("inbox/boa.md"))).toBe(true);
    } finally {
      chmodSync(badPath, 0o600);
    }
  });

  it("cofre simples sem v2/grafo preserva triagem e dedupe lexical", async () => {
    const cwd = root();
    VaultEngine.init(cwd);
    writeNote(cwd, "inbox/decisao.md", "# Decisão\n\nsimples sem v2.\n");
    const body = "duplicata simples lexical cofre basico";
    writeNote(cwd, "references/x.md", `# X\n\n${body}\n`);
    writeNote(cwd, "references/y.md", `# Y\n\n${body}\n`);

    const result = await DreamEngine.run(cwd, { dryRun: true });
    expect(result.state).toBe("sucesso");
    expect(actions(result, "sugerida").some((item) => item.category === "triagem")).toBe(true);
    expect(actions(result, "sugerida").some((item) => item.category === "duplicata" && item.mechanism === "lexical")).toBe(
      true,
    );
  });

  it("memory sync segue operacional apos dream apply", async () => {
    const cwd = root();
    VaultEngine.init(cwd);
    writeNote(cwd, "inbox/decisao.md", "# Decisão\n\nsync apos dream.\n");
    VaultEngine.sync(cwd);

    await DreamEngine.run(cwd);
    const sync = VaultEngine.sync(cwd);
    expect(sync.state).toBe("sucesso");
  });

  it("superficie MCP permanece com 12 tools", () => {
    expect(MCP_TOOL_NAMES).toHaveLength(12);
  });
});
