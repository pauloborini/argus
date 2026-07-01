import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { buildDiscoveryManifest, fingerprintDiscoveredFiles } from "../discovery/fingerprint.js";
import { writeManifestAtomic } from "../discovery/manifest.js";
import { countTokens } from "../packing/tokenizer.js";
import { discoverFiles } from "../discovery/walk.js";
import { buildStructuralIndex } from "../extraction/pipeline.js";
import { buildToolResponse } from "../mcp/tools/response.js";
import { persistFullStructuralIndex } from "../storage/index-persistence.js";
import { getManifestPath, initWorkspace } from "../workspace/workspace.js";

// ===========================================================================
// Benchmark honesto (item 21). Três arms por task, ground-truth verificável,
// tokens por heurística aproximada offline. NÃO mede agente vivo — os números
// são "limite superior interno scriptado" (ver writeSummary §Metodologia).
// ===========================================================================

type BenchmarkArm = "baseline" | "formato-so" | "argus";
type TaskKind = "cirurgica" | "varredura";
type ToolName = "status" | "files" | "search" | "explore" | "trace" | "impact" | "diff_impact" | "pack_context";

const ARMS: BenchmarkArm[] = ["baseline", "formato-so", "argus"];

interface StepResult {
  title: string;
  output: string;
  ok: boolean;
}

/** Resposta correta da task, independente do arm. Cada arm é medido contra ela. */
interface GroundTruth {
  /** Arquivos que a resposta correta precisa citar (substring nas saídas reais). */
  mustCite: string[];
  /** Símbolo-âncora que deve aparecer na saída real do arm (opcional). */
  mustContainSymbol?: string;
}

interface BenchmarkTaskResult {
  id: string;
  title: string;
  kind: TaskKind;
  arm: BenchmarkArm;
  repo_label: string;
  repo_path: string;
  tool_calls: number;
  tokens: number;
  tempo_ms: number;
  /** Mediu objetivamente se o arm surfou o ground-truth (mustCite + símbolo). */
  correct: boolean;
  cited_expected: number;
  expected_total: number;
  /** Medido (não fixado): o arm declarou incerteza/staleness na saída real? */
  uncertainty_disclosed: boolean;
  steps: StepResult[];
}

interface ArmTotals {
  tool_calls: number;
  tokens: number;
  correct_count: number;
  uncertainty_disclosed_count: number;
  task_count: number;
}

interface BenchmarkSummary {
  generated_at: string;
  output_dir: string;
  methodology: {
    token_counter: string;
    arms: string;
    utility: string;
    live_agent: string;
    label: string;
  };
  totals: Record<BenchmarkArm, ArmTotals>;
  gains: {
    /** baseline → formato-so: ganho de pura serialização. */
    format_token_pct: number;
    /** formato-so → argus: ganho incremental do índice estruturado. */
    index_token_pct: number;
    /** baseline → argus: headline honesto (qualificado). */
    headline_token_pct: number;
    headline_tool_call_pct: number;
  };
  by_kind: Record<TaskKind, {
    baseline_tokens: number;
    formato_so_tokens: number;
    argus_tokens: number;
    headline_token_pct: number;
    index_token_pct: number;
  }>;
  pass: boolean;
  tasks: BenchmarkTaskResult[];
}

interface TaskContext {
  workspaceRoot: string;
  outputDir: string;
  codegraphDiffRoot: string;
  corpusRoots: {
    codegraph: string;
    gitnexus: string;
    headroom: string;
    understandAnything: string;
  };
}

interface ArgusStep {
  title: string;
  tool: ToolName;
  args?: Record<string, unknown>;
}

interface TaskSpec {
  id: string;
  title: string;
  kind: TaskKind;
  groundTruth: GroundTruth;
  /** Resolve a raiz do repo-alvo (corpus indexado). */
  repo: (ctx: TaskContext) => { label: string; path: string };
  /** Primeiro passo realista do agente sem índice. */
  baselineGrep: string;
  /** Arquivos que o agente abre por inteiro para confirmar a resposta. */
  baselineFiles: string[];
  /** Chamadas reais de tool no arm com índice (já em `concise`). */
  argusSteps: ArgusStep[];
  /**
   * Hook para o follow-up de agente vivo (loop real com/sem tools). Não
   * implementado nesta fase — ver writeSummary §Metodologia.
   */
  runLiveAgent?: (ctx: TaskContext) => StepResult[];
}

// --- Tokenizer (aproximação documentada) -----------------------------------
// Delegado a src/packing/tokenizer.ts (countTokens).
export { countTokens as approxTokens } from "../packing/tokenizer.js";

/**
 * Re-serialização compacta usada no arm `formato-so`: mesma informação do
 * baseline, sem o overhead de formato — remove prefixos de linha (`123:`),
 * indentação à esquerda, espaços à direita e colapsa runs de linhas em branco.
 * O payload de código é preservado. Isola o ganho de "não vazar tokens no
 * formato" do ganho do índice.
 */
export function compactSerialize(text: string): string {
  const lines = text.split("\n").map((line) =>
    line
      .replace(/^\s*\d+[:\t]/, "")
      .replace(/^\s+/, "")
      .replace(/\s+$/, ""),
  );
  const collapsed: string[] = [];
  for (const line of lines) {
    if (line === "" && collapsed[collapsed.length - 1] === "") {
      continue;
    }
    collapsed.push(line);
  }
  return collapsed.join("\n").trim();
}

/**
 * Avaliação objetiva contra ground-truth: substitui a `scoreUtility` antiga
 * (auto-pontuada pelo autor). Mede se as saídas REAIS do arm contêm os arquivos
 * esperados e o símbolo-âncora — não se a prosa escrita pelo autor passa em
 * barras. Sem juiz, reprodutível.
 */
export function evaluateAnswer(
  stepOutputs: string,
  groundTruth: GroundTruth,
): { correct: boolean; citedExpected: number; expectedTotal: number; uncertaintyDisclosed: boolean } {
  const haystack = stepOutputs;
  const citedExpected = groundTruth.mustCite.filter((path) => haystack.includes(path)).length;
  const symbolOk = !groundTruth.mustContainSymbol || haystack.includes(groundTruth.mustContainSymbol);
  const correct = citedExpected === groundTruth.mustCite.length && symbolOk;
  const uncertaintyDisclosed = /\bstale\b|staleness|limitations|incomplet|parcial|pending|E_[A-Z]|W_[A-Z]/i.test(
    haystack,
  );
  return {
    correct,
    citedExpected,
    expectedTotal: groundTruth.mustCite.length,
    uncertaintyDisclosed,
  };
}

// --- Infra ------------------------------------------------------------------

function nowIso(): string {
  return new Date().toISOString();
}

function ensureDir(pathValue: string): void {
  mkdirSync(pathValue, { recursive: true });
}

function resolveWorkspaceRoot(start: string): string {
  let current = resolve(start);
  while (true) {
    const packageJsonPath = join(current, "package.json");
    const backlogPath = join(current, ".argus/backlog/BACKLOG_MESTRE_argus.md");
    if (existsSync(packageJsonPath) && existsSync(backlogPath)) {
      try {
        const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as { name?: string };
        if (pkg.name === "argus") {
          return current;
        }
      } catch {
        // keep walking upward
      }
    }
    const parent = dirname(current);
    if (parent === current) {
      return resolve(start);
    }
    current = parent;
  }
}

function runShellStep(cwd: string, title: string, command: string): StepResult {
  const result = spawnSync("zsh", ["-lc", command], {
    cwd,
    encoding: "utf-8",
    maxBuffer: 16 * 1024 * 1024,
  });
  const output = [result.stdout, result.stderr].filter(Boolean).join("").trim();
  return { title, output, ok: result.status === 0 };
}

/**
 * Baseline realista: o agente abre o arquivo inteiro (não recola `sed`). O custo
 * é o corpo completo, com um header `// FILE:` como um agente real recebe.
 */
function readFullFileStep(cwd: string, relPath: string): StepResult {
  const abs = join(cwd, relPath);
  if (!existsSync(abs)) {
    return { title: `read ${relPath}`, output: `// FILE: ${relPath}\n(arquivo ausente no snapshot)`, ok: false };
  }
  const body = readFileSync(abs, "utf-8");
  return { title: `read ${relPath}`, output: `// FILE: ${relPath}\n${body}`, ok: true };
}

function runToolStep(cwd: string, title: string, tool: ToolName, args?: Record<string, unknown>): StepResult {
  const payload = buildToolResponse(tool, cwd, { ...args, response_format: "concise" });
  return { title, output: JSON.stringify(payload), ok: payload.state !== "falha" };
}

async function ensureIndexed(rootPath: string): Promise<void> {
  initWorkspace(rootPath);
  const discovery = discoverFiles(rootPath);
  const fingerprints = fingerprintDiscoveredFiles(discovery.files);
  const manifest = buildDiscoveryManifest(rootPath, fingerprints);
  const { index } = await buildStructuralIndex(manifest, rootPath);
  writeManifestAtomic(getManifestPath(rootPath), manifest);
  persistFullStructuralIndex(rootPath, index);
}

export function copyCorpusSnapshot(source: string, target: string): void {
  rmSync(target, { recursive: true, force: true });
  ensureDir(dirname(target));
  cpSync(source, target, {
    recursive: true,
    filter: (src) => !src.includes("/.argus/") && !src.endsWith("/.argus"),
  });
}

function prepareBenchmarkCorpus(workspaceRoot: string, outputDir: string): TaskContext["corpusRoots"] {
  const corpusRoot = join(outputDir, "tmp", "corpus");
  rmSync(corpusRoot, { recursive: true, force: true });

  const codegraph = join(corpusRoot, "codegraph");
  const gitnexus = join(corpusRoot, "GitNexus");
  const headroom = join(corpusRoot, "headroom");
  const understandAnything = join(corpusRoot, "Understand-Anything");

  copyCorpusSnapshot(join(workspaceRoot, ".app-vault/archive/codegraph"), codegraph);
  copyCorpusSnapshot(join(workspaceRoot, ".app-vault/archive/GitNexus"), gitnexus);
  copyCorpusSnapshot(join(workspaceRoot, ".app-vault/archive/headroom"), headroom);
  copyCorpusSnapshot(join(workspaceRoot, ".app-vault/archive/Understand-Anything"), understandAnything);

  return { codegraph, gitnexus, headroom, understandAnything };
}

function createCodegraphDiffSnapshot(workspaceRoot: string, outputDir: string): string {
  const source = join(workspaceRoot, ".app-vault/archive/codegraph");
  const target = join(outputDir, "tmp", "codegraph-diff");
  copyCorpusSnapshot(source, target);

  runShellStep(target, "git init", "git init");
  runShellStep(target, "git config", "git config user.email bench@example.com && git config user.name 'Bench'");
  runShellStep(target, "git add", "git add .");
  runShellStep(target, "git commit", "git commit -m 'baseline snapshot'");

  const targetFile = join(target, "src/sync/watch-policy.ts");
  const original = readFileSync(targetFile, "utf-8");
  if (!original.includes("// benchmark-touch")) {
    writeFileSync(targetFile, `${original}\n// benchmark-touch: validar impacto de watch policy\n`, "utf-8");
  }

  return target;
}

// --- Execução das tasks -----------------------------------------------------

function buildArmResult(
  spec: TaskSpec,
  ctx: TaskContext,
  arm: BenchmarkArm,
): BenchmarkTaskResult {
  const repo = spec.repo(ctx);
  const root = repo.path;
  const startedAt = Date.now();

  let steps: StepResult[];
  if (arm === "argus") {
    steps = spec.argusSteps.map((step) => runToolStep(root, step.title, step.tool, step.args));
  } else {
    const raw: StepResult[] = [
      runShellStep(root, "rg localizar", spec.baselineGrep),
      ...spec.baselineFiles.map((file) => readFullFileStep(root, file)),
    ];
    steps = arm === "formato-so"
      ? raw.map((step) => ({ ...step, output: compactSerialize(step.output) }))
      : raw;
  }

  const combined = steps.map((step) => step.output).join("\n");
  const tokens = steps.reduce((sum, step) => sum + countTokens(step.output), 0);
  const evalResult = evaluateAnswer(combined, spec.groundTruth);

  return {
    id: spec.id,
    title: spec.title,
    kind: spec.kind,
    arm,
    repo_label: repo.label,
    repo_path: root,
    tool_calls: steps.length,
    tokens,
    tempo_ms: Date.now() - startedAt,
    correct: evalResult.correct,
    cited_expected: evalResult.citedExpected,
    expected_total: evalResult.expectedTotal,
    uncertainty_disclosed: evalResult.uncertaintyDisclosed,
    steps,
  };
}

const TASKS: TaskSpec[] = [
  {
    id: "BT-01",
    title: "Localizar área certa para uma tool MCP",
    kind: "cirurgica",
    groundTruth: { mustCite: ["src/mcp/tools.ts", "src/graph/traversal.ts"], mustContainSymbol: "getImpactRadius" },
    repo: (ctx) => ({ label: "CodeGraph", path: ctx.corpusRoots.codegraph }),
    baselineGrep:
      "rg -n \"codegraph_impact|handleImpact|getImpactRadius\" src/mcp/tools.ts src/bin/codegraph.ts src/graph/traversal.ts src/index.ts",
    baselineFiles: ["src/mcp/tools.ts", "src/graph/traversal.ts"],
    argusSteps: [
      { title: "search getImpactRadius", tool: "search", args: { query: "getImpactRadius", limit: 3 } },
      { title: "explore tools.ts", tool: "explore", args: { target: "src/mcp/tools.ts", mode: "file", depth: 2 } },
      { title: "impact tools.ts", tool: "impact", args: { target: "src/mcp/tools.ts", direction: "dependencies", depth: 2, summary_only: true } },
    ],
  },
  {
    id: "BT-02",
    title: "Explicar fluxo de trace/impacto",
    kind: "cirurgica",
    groundTruth: {
      mustCite: ["gitnexus/src/mcp/local/local-backend.ts", "gitnexus/src/core/group/cross-impact.ts"],
      mustContainSymbol: "_impactImpl",
    },
    repo: (ctx) => ({ label: "GitNexus", path: ctx.corpusRoots.gitnexus }),
    baselineGrep:
      "rg -n \"impactCommand|_impactImpl|safeLocalImpact|cross-impact|crossImpact\" gitnexus/src/cli/tool.ts gitnexus/src/mcp/local/local-backend.ts gitnexus/src/core/group/cross-impact.ts",
    baselineFiles: ["gitnexus/src/mcp/local/local-backend.ts", "gitnexus/src/core/group/cross-impact.ts"],
    argusSteps: [
      { title: "search _impactImpl", tool: "search", args: { query: "_impactImpl", limit: 5 } },
      { title: "files cross-impact", tool: "files", args: { pattern: "cross-impact", max_depth: 6 } },
    ],
  },
  {
    id: "BT-03",
    title: "Avaliar impacto de mudança em sync/staleness",
    kind: "varredura",
    groundTruth: { mustCite: ["src/sync/index.ts", "src/mcp/engine.ts"], mustContainSymbol: "watchDisabledReason" },
    repo: (ctx) => ({ label: "CodeGraph", path: ctx.corpusRoots.codegraph }),
    baselineGrep:
      "rg -n \"watchDisabledReason|FileWatcher|pending sync|auto-sync|catch-up sync\" src/sync/index.ts src/mcp/engine.ts src/mcp/tools.ts src/index.ts",
    baselineFiles: ["src/sync/index.ts", "src/mcp/engine.ts"],
    argusSteps: [
      { title: "files sync", tool: "files", args: { pattern: "src/sync", max_depth: 3 } },
      { title: "explore engine.ts", tool: "explore", args: { target: "src/mcp/engine.ts", mode: "file", depth: 2 } },
      { title: "search watchDisabledReason", tool: "search", args: { query: "watchDisabledReason", limit: 5 } },
    ],
  },
  {
    id: "BT-04",
    title: "Identificar packing reversível aplicável",
    kind: "varredura",
    groundTruth: {
      mustCite: ["crates/headroom-core/src/ccr/mod.rs", "crates/headroom-core/src/transforms/pipeline/mod.rs"],
      mustContainSymbol: "CompressionStore",
    },
    repo: (ctx) => ({ label: "Headroom", path: ctx.corpusRoots.headroom }),
    baselineGrep:
      "rg -n \"CCR|compress_with_store|CompressionStore\" crates/headroom-core/src/ccr/mod.rs crates/headroom-core/src/transforms/pipeline/mod.rs",
    baselineFiles: ["crates/headroom-core/src/ccr/mod.rs", "crates/headroom-core/src/transforms/pipeline/mod.rs"],
    argusSteps: [
      { title: "search CompressionStore", tool: "search", args: { query: "CompressionStore", limit: 5 } },
      { title: "explore ccr mod", tool: "explore", args: { target: "crates/headroom-core/src/ccr/mod.rs", mode: "file", depth: 2 } },
      {
        title: "pack ccr",
        tool: "pack_context",
        args: {
          sources: ["crates/headroom-core/src/ccr/mod.rs", "crates/headroom-core/src/transforms/pipeline/mod.rs"],
          goal: "extrair inspiracoes de packing reversivel",
          token_budget: 420,
          style: "balanced",
        },
      },
    ],
  },
  {
    id: "BT-05",
    title: "Comparar diff e testes afetados",
    kind: "cirurgica",
    groundTruth: { mustCite: ["src/sync/watch-policy.ts"], mustContainSymbol: "watch-policy" },
    repo: (ctx) => ({ label: "CodeGraph (diff)", path: ctx.codegraphDiffRoot }),
    baselineGrep: "git diff --name-only && rg -n \"watch|sync|policy\" __tests__ src --glob '*.test.ts' || true",
    baselineFiles: ["src/sync/watch-policy.ts"],
    argusSteps: [
      { title: "diff_impact unstaged", tool: "diff_impact", args: { scope: "unstaged" } },
      {
        title: "pack changed file",
        tool: "pack_context",
        args: { sources: ["src/sync/watch-policy.ts"], goal: "testes e areas afetadas pelo diff", token_budget: 320, style: "brief" },
      },
    ],
  },
  {
    id: "BT-06",
    title: "Rejeitar escopo visual/plataforma",
    kind: "varredura",
    groundTruth: {
      mustCite: [
        "understand-anything-plugin/packages/dashboard/src/App.tsx",
        "understand-anything-plugin/src/onboard-builder.ts",
      ],
      mustContainSymbol: "buildOnboardingGuide",
    },
    repo: (ctx) => ({ label: "Understand Anything", path: ctx.corpusRoots.understandAnything }),
    baselineGrep:
      "rg -n \"dashboard|onboard|buildOnboardingGuide\" understand-anything-plugin/packages/dashboard/src understand-anything-plugin/src",
    baselineFiles: [
      "understand-anything-plugin/packages/dashboard/src/App.tsx",
      "understand-anything-plugin/src/onboard-builder.ts",
    ],
    argusSteps: [
      { title: "files dashboard", tool: "files", args: { pattern: "packages/dashboard/src", max_depth: 6 } },
      { title: "search buildOnboardingGuide", tool: "search", args: { query: "buildOnboardingGuide", limit: 3 } },
    ],
  },
];

// --- Agregação e relatório --------------------------------------------------

function emptyTotals(): ArmTotals {
  return { tool_calls: 0, tokens: 0, correct_count: 0, uncertainty_disclosed_count: 0, task_count: 0 };
}

export function computeTotals(tasks: BenchmarkTaskResult[]): Record<BenchmarkArm, ArmTotals> {
  const totals: Record<BenchmarkArm, ArmTotals> = {
    baseline: emptyTotals(),
    "formato-so": emptyTotals(),
    argus: emptyTotals(),
  };
  for (const task of tasks) {
    const bucket = totals[task.arm];
    bucket.tool_calls += task.tool_calls;
    bucket.tokens += task.tokens;
    bucket.correct_count += task.correct ? 1 : 0;
    bucket.uncertainty_disclosed_count += task.uncertainty_disclosed ? 1 : 0;
    bucket.task_count += 1;
  }
  return totals;
}

function pct(from: number, to: number): number {
  return from === 0 ? 0 : ((from - to) / from) * 100;
}

export function computeSummary(tasks: BenchmarkTaskResult[], outputDir: string): BenchmarkSummary {
  const totals = computeTotals(tasks);

  const gains = {
    format_token_pct: pct(totals.baseline.tokens, totals["formato-so"].tokens),
    index_token_pct: pct(totals["formato-so"].tokens, totals.argus.tokens),
    headline_token_pct: pct(totals.baseline.tokens, totals.argus.tokens),
    headline_tool_call_pct: pct(totals.baseline.tool_calls, totals.argus.tool_calls),
  };

  const byKind = {} as BenchmarkSummary["by_kind"];
  for (const kind of ["cirurgica", "varredura"] as TaskKind[]) {
    const sel = (arm: BenchmarkArm): number =>
      tasks.filter((t) => t.kind === kind && t.arm === arm).reduce((s, t) => s + t.tokens, 0);
    const baseTok = sel("baseline");
    const fmtTok = sel("formato-so");
    const argusTok = sel("argus");
    byKind[kind] = {
      baseline_tokens: baseTok,
      formato_so_tokens: fmtTok,
      argus_tokens: argusTok,
      headline_token_pct: pct(baseTok, argusTok),
      index_token_pct: pct(fmtTok, argusTok),
    };
  }

  // Gate honesto: o índice precisa surfar o ground-truth em TODA task e o
  // headline de tokens precisa ser positivo. Sem barras de utilidade fabricadas.
  const argusCorrect = totals.argus.correct_count === totals.argus.task_count;
  const pass = argusCorrect && gains.headline_token_pct > 0;

  return {
    generated_at: nowIso(),
    output_dir: outputDir,
    methodology: {
      token_counter: "Heurística subword offline (approxTokens) — APROXIMAÇÃO, não o tokenizer do modelo alvo.",
      arms: "baseline (file reads crus) → formato-so (mesma info, serialização compacta) → argus (tools reais concise).",
      utility: "Checagem objetiva contra ground-truth (mustCite + símbolo nas saídas REAIS); uncertainty medido.",
      live_agent: "NÃO implementado — números são scriptados. Hook runLiveAgent reservado para follow-up.",
      label: "LIMITE SUPERIOR INTERNO SCRIPTADO (sem agente vivo; tokens por heurística aproximada).",
    },
    totals,
    gains,
    by_kind: byKind,
    pass,
    tasks,
  };
}

function writeEvidence(outputDir: string, task: BenchmarkTaskResult): void {
  const filename = `${task.id}-${task.arm}.md`;
  const content = [
    `### ${task.id} — ${task.arm} (${task.kind})`,
    "",
    `- Data: ${nowIso()}`,
    `- Repo: ${task.repo_label}`,
    `- Tool calls: ${task.tool_calls}`,
    `- Tokens (aprox.): ${task.tokens}`,
    `- Tempo: ${task.tempo_ms}ms`,
    `- Correto (ground-truth): ${task.correct ? "sim" : "não"} (${task.cited_expected}/${task.expected_total} arquivos)`,
    `- Incerteza declarada (medido): ${task.uncertainty_disclosed ? "sim" : "não"}`,
    "",
    "#### Evidência bruta",
    "",
    ...task.steps.flatMap((step) => [`##### ${step.title}`, "", "```text", step.output || "(sem saída)", "```", ""]),
  ].join("\n");
  writeFileSync(join(outputDir, filename), content + "\n", "utf-8");
}

function fmtPct(value: number): string {
  if (Math.abs(value) < 0.05) {
    return "~0%";
  }
  const sign = value >= 0 ? "−" : "+";
  return `${sign}${Math.abs(value).toFixed(1)}%`;
}

function writeSummary(outputDir: string, summary: BenchmarkSummary): void {
  writeFileSync(join(outputDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n", "utf-8");

  const taskRow = (t: BenchmarkTaskResult): string =>
    `| ${t.id} | ${t.arm} | ${t.tool_calls} | ${t.tokens} | ${t.correct ? "✓" : "✗"} | ${t.uncertainty_disclosed ? "✓" : "—"} |`;

  const content = [
    "# Benchmark interno — Argus (item 21, honesto)",
    "",
    `Gerado em: ${summary.generated_at}`,
    "",
    `> **${summary.methodology.label}**`,
    "",
    "## Headline (qualificado)",
    "",
    `- Tokens baseline → argus: ${fmtPct(summary.gains.headline_token_pct)} (headline honesto)`,
    `- Tool calls baseline → argus: ${fmtPct(summary.gains.headline_tool_call_pct)}`,
    "",
    "### Decomposição formato vs índice",
    "",
    `- Ganho de **formato** (baseline → formato-só): ${fmtPct(summary.gains.format_token_pct)}`,
    `- Ganho de **índice** (formato-só → argus): ${fmtPct(summary.gains.index_token_pct)}`,
    "",
    "## Totais por arm",
    "",
    "| Arm | Tool calls | Tokens | Corretos | Incerteza declarada |",
    "|---|---|---|---|---|",
    ...ARMS.map(
      (arm) =>
        `| ${arm} | ${summary.totals[arm].tool_calls} | ${summary.totals[arm].tokens} | ${summary.totals[arm].correct_count}/${summary.totals[arm].task_count} | ${summary.totals[arm].uncertainty_disclosed_count}/${summary.totals[arm].task_count} |`,
    ),
    "",
    "## Perfil cirúrgica × varredura (tokens)",
    "",
    "| Kind | Baseline | Formato-só | Argus | Headline | Ganho índice |",
    "|---|---|---|---|---|---|",
    ...(["cirurgica", "varredura"] as TaskKind[]).map(
      (k) =>
        `| ${k} | ${summary.by_kind[k].baseline_tokens} | ${summary.by_kind[k].formato_so_tokens} | ${summary.by_kind[k].argus_tokens} | ${fmtPct(summary.by_kind[k].headline_token_pct)} | ${fmtPct(summary.by_kind[k].index_token_pct)} |`,
    ),
    "",
    "## Por task",
    "",
    "| Task | Arm | Tool calls | Tokens | Correto | Incerteza |",
    "|---|---|---|---|---|---|",
    ...summary.tasks.map(taskRow),
    "",
    `Gate: ${summary.pass ? "PASS" : "FAIL"} (índice surfa ground-truth em toda task + headline positivo)`,
    "",
    "## Metodologia",
    "",
    `- **Tokens**: ${summary.methodology.token_counter}`,
    `- **Arms**: ${summary.methodology.arms}`,
    `- **Utilidade**: ${summary.methodology.utility}`,
    `- **Agente vivo**: ${summary.methodology.live_agent}`,
    "- **formato-só é arm sintético construído**: aplica `compactSerialize` ao conteúdo do baseline (mesma informação), aproximando a disciplina de serialização do envelope `concise`.",
    "- **Ground-truth por task**: arquivos/símbolo corretos verificados como substring nas saídas reais — não em prosa do autor.",
    "- **Por que o ganho de formato ≈ 0**: sob um contador subword, disciplina de serialização (indentação, linhas em branco) custa ~0 token — whitespace praticamente não tokeniza. Todo o ganho vem de o índice entregar MENOS conteúdo (ranges/handles em vez de arquivos inteiros), não de reformatar. É um resultado honesto, não um bug.",
    "- O perfil cirúrgica×varredura é reportado separado: o índice ganha mais em lookup pontual; em varredura ampla o ganho é menor.",
  ].join("\n");

  writeFileSync(join(outputDir, "SUMMARY.md"), content + "\n", "utf-8");
}

export async function runMvpBenchmark(workspaceRoot: string, outputDir: string): Promise<BenchmarkSummary> {
  ensureDir(outputDir);

  const corpusRoots = prepareBenchmarkCorpus(workspaceRoot, outputDir);

  await ensureIndexed(corpusRoots.codegraph);
  await ensureIndexed(corpusRoots.gitnexus);
  await ensureIndexed(corpusRoots.headroom);
  await ensureIndexed(corpusRoots.understandAnything);

  const codegraphDiffRoot = createCodegraphDiffSnapshot(workspaceRoot, outputDir);
  await ensureIndexed(codegraphDiffRoot);

  const ctx: TaskContext = { workspaceRoot, outputDir, codegraphDiffRoot, corpusRoots };

  const tasks: BenchmarkTaskResult[] = [];
  for (const spec of TASKS) {
    for (const arm of ARMS) {
      const result = buildArmResult(spec, ctx, arm);
      tasks.push(result);
      writeEvidence(outputDir, result);
    }
  }

  const summary = computeSummary(tasks, outputDir);
  writeSummary(outputDir, summary);
  return summary;
}

async function main(): Promise<void> {
  const argRoot = process.argv[2];
  const workspaceRoot = argRoot ? resolve(process.cwd(), argRoot) : resolveWorkspaceRoot(process.cwd());
  const outputDir = resolve(workspaceRoot, ".argus/benchmark/latest");
  const summary = await runMvpBenchmark(workspaceRoot, outputDir);
  console.log(JSON.stringify(summary, null, 2));
  process.exit(summary.pass ? 0 : 1);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (import.meta.url === `file://${invokedPath}`) {
  main().catch((err: unknown) => {
    const message = err instanceof Error ? err.stack ?? err.message : String(err);
    console.error(message);
    process.exit(1);
  });
}
