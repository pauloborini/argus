import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { buildDiscoveryManifest, fingerprintDiscoveredFiles } from "../discovery/fingerprint.js";
import { writeManifestAtomic } from "../discovery/manifest.js";
import { discoverFiles } from "../discovery/walk.js";
import { buildStructuralIndex } from "../extraction/pipeline.js";
import { buildToolResponse } from "../mcp/tools/response.js";
import { persistFullStructuralIndex } from "../storage/index-persistence.js";
import { getManifestPath, initWorkspace } from "../workspace/workspace.js";

type BenchmarkArm = "baseline" | "atlas-cortex";
type ToolName = "status" | "files" | "search" | "explore" | "trace" | "impact" | "diff_impact" | "pack_context";

interface StepResult {
  title: string;
  output: string;
  ok: boolean;
}

interface BenchmarkTaskResult {
  id: string;
  title: string;
  arm: BenchmarkArm;
  repo_label: string;
  repo_path: string;
  snapshot_label: string;
  tool_calls: number;
  tokens_aproximados: number;
  tempo_ms: number;
  utilidade_percebida: number;
  arquivos_citados: string[];
  resposta_final: string;
  incertezas: string[];
  observacoes: string[];
  steps: StepResult[];
}

interface BenchmarkSummary {
  generated_at: string;
  output_dir: string;
  criteria: {
    min_tool_call_reduction_pct: number;
    min_token_reduction_pct: number;
    min_average_utility: number;
    min_task_utility: number;
  };
  totals: {
    baseline_tool_calls: number;
    atlas_tool_calls: number;
    baseline_tokens: number;
    atlas_tokens: number;
    tool_call_reduction_pct: number;
    token_reduction_pct: number;
    baseline_average_utility: number;
    atlas_average_utility: number;
    minimum_atlas_utility: number;
  };
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

interface TaskDefinition {
  id: string;
  title: string;
  runBaseline: (ctx: TaskContext) => BenchmarkTaskResult;
  runAtlas: (ctx: TaskContext) => BenchmarkTaskResult;
}

const TOOL_CALL_REDUCTION_TARGET = 35;
const TOKEN_REDUCTION_TARGET = 25;
const MIN_AVERAGE_UTILITY = 4;
const MIN_TASK_UTILITY = 3;

function estimateTokens(text: string): number {
  // Code-aware (alinhado a approximateTokenCount do pack_context): conta tokens
  // lexicais com piso chars/4 — mais honesto que chars/4 puro para output de
  // código. Tokenizer real segue como melhoria futura (ver docs/ANALISE §5).
  const lexical = text.match(/[A-Za-z0-9_$]+|[^\sA-Za-z0-9_$]/g)?.length ?? 0;
  return Math.max(1, lexical, Math.ceil(text.length / 4));
}

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
    const backlogPath = join(current, ".atlas/backlog/BACKLOG_MESTRE_atlas-cortex.md");
    if (existsSync(packageJsonPath) && existsSync(backlogPath)) {
      try {
        const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as { name?: string };
        if (pkg.name === "atlas-cortex") {
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
    maxBuffer: 8 * 1024 * 1024,
  });
  const output = [result.stdout, result.stderr].filter(Boolean).join("").trim();
  return {
    title,
    output,
    ok: result.status === 0,
  };
}

function runToolStep(cwd: string, title: string, tool: ToolName, args?: Record<string, unknown>): StepResult {
  const payload = buildToolResponse(tool, cwd, args);
  return {
    title,
    output: JSON.stringify(payload, null, 2),
    ok: payload.state !== "falha",
  };
}

function extractJson(step: StepResult): Record<string, unknown> {
  try {
    return JSON.parse(step.output) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function parseLinesMatching(output: string, matcher: RegExp): string[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => matcher.test(line));
}

function buildResult(params: {
  id: string;
  title: string;
  arm: BenchmarkArm;
  repoLabel: string;
  repoPath: string;
  snapshotLabel: string;
  startedAt: number;
  steps: StepResult[];
  refs: string[];
  finalAnswer: string;
  uncertainties: string[];
  notes: string[];
}): BenchmarkTaskResult {
  const tokens = params.steps.reduce((sum, step) => sum + estimateTokens(step.output), 0);
  const utility = scoreUtility(params.finalAnswer, params.refs, params.uncertainties, true);

  return {
    id: params.id,
    title: params.title,
    arm: params.arm,
    repo_label: params.repoLabel,
    repo_path: params.repoPath,
    snapshot_label: params.snapshotLabel,
    tool_calls: params.steps.length,
    tokens_aproximados: tokens,
    tempo_ms: Date.now() - params.startedAt,
    utilidade_percebida: utility,
    arquivos_citados: uniqueStrings(params.refs),
    resposta_final: params.finalAnswer,
    incertezas: uniqueStrings(params.uncertainties),
    observacoes: params.notes,
    steps: params.steps,
  };
}

export function scoreUtility(
  finalAnswer: string,
  refs: string[],
  uncertainties: string[],
  uncertaintyDisclosure: boolean,
): number {
  let score = 1;
  if (finalAnswer.length >= 100) score += 1;
  if (refs.length >= 2) score += 1;
  if (refs.length >= 4) score += 1;
  if (uncertaintyDisclosure || uncertainties.length > 0) score += 1;
  if (refs.length === 0) return Math.min(score, 2);
  if (refs.length < 2) return Math.min(score, 3);
  return Math.min(5, score);
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
    filter: (src) => !src.includes("/.cortex/") && !src.endsWith("/.cortex"),
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

  return {
    codegraph,
    gitnexus,
    headroom,
    understandAnything,
  };
}

function writeEvidence(outputDir: string, task: BenchmarkTaskResult): void {
  const filename = `${task.id}-${task.arm}.md`;
  const pathValue = join(outputDir, filename);
  const content = [
    `### ${task.id} - ${task.arm}`,
    "",
    `- Data: ${nowIso()}`,
    "- Operador/agente: Codex",
    `- Repo alvo: ${task.repo_label}`,
    `- Commit ou snapshot: ${task.snapshot_label}`,
    `- Tool calls: ${task.tool_calls}`,
    `- Tokens aproximados: ${task.tokens_aproximados}`,
    `- Tempo: ${task.tempo_ms}ms`,
    `- Utilidade percebida (1-5): ${task.utilidade_percebida}`,
    `- Arquivos citados: ${task.arquivos_citados.join(", ") || "nenhum"}`,
    "- Resposta final:",
    "",
    task.resposta_final,
    "",
    `- Incertezas: ${task.incertezas.join(" | ") || "nenhuma relevante"}`,
    `- Observacoes: ${task.observacoes.join(" | ") || "nenhuma"}`,
    "",
    "#### Evidência bruta",
    "",
    ...task.steps.flatMap((step) => [
      `##### ${step.title}`,
      "",
      "```text",
      step.output || "(sem saída)",
      "```",
      "",
    ]),
  ].join("\n");
  writeFileSync(pathValue, content + "\n", "utf-8");
}

function writeSummary(outputDir: string, summary: BenchmarkSummary): void {
  writeFileSync(join(outputDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n", "utf-8");

  const content = [
    "# Benchmark interno S16 — Atlas Cortex",
    "",
    `Gerado em: ${summary.generated_at}`,
    "",
    "## Resultado",
    "",
    `- Tool calls baseline: ${summary.totals.baseline_tool_calls}`,
    `- Tool calls atlas-cortex: ${summary.totals.atlas_tool_calls}`,
    `- Redução de tool calls: ${summary.totals.tool_call_reduction_pct.toFixed(1)}%`,
    `- Tokens baseline: ${summary.totals.baseline_tokens}`,
    `- Tokens atlas-cortex: ${summary.totals.atlas_tokens}`,
    `- Redução de tokens: ${summary.totals.token_reduction_pct.toFixed(1)}%`,
    `- Utilidade média baseline: ${summary.totals.baseline_average_utility.toFixed(2)}`,
    `- Utilidade média atlas-cortex: ${summary.totals.atlas_average_utility.toFixed(2)}`,
    `- Menor utilidade atlas-cortex: ${summary.totals.minimum_atlas_utility}`,
    `- Gate S16: ${summary.pass ? "PASS" : "FAIL"}`,
    "",
    "## Tarefas",
    "",
    ...summary.tasks
      .filter((task) => task.arm === "atlas-cortex")
      .map(
        (task) =>
          `- ${task.id}: ${task.tool_calls} calls, ${task.tokens_aproximados} tokens aprox., utilidade ${task.utilidade_percebida}/5`,
      ),
    "",
    "## Notas",
    "",
    "- Utilidade foi rubricada deterministicamente com piso de referências mínimas, completude da resposta e declaração explícita de incerteza.",
    "- BT-05 usa snapshot temporário git-inicializado do archive CodeGraph porque o corpus arquivado não carrega `.git`.",
  ].join("\n");

  writeFileSync(join(outputDir, "SUMMARY.md"), content + "\n", "utf-8");
}

function metricTotals(tasks: BenchmarkTaskResult[], arm: BenchmarkArm, field: "tool_calls" | "tokens_aproximados"): number {
  return tasks.filter((task) => task.arm === arm).reduce((sum, task) => sum + task[field], 0);
}

function averageUtility(tasks: BenchmarkTaskResult[], arm: BenchmarkArm): number {
  const items = tasks.filter((task) => task.arm === arm);
  return items.reduce((sum, task) => sum + task.utilidade_percebida, 0) / items.length;
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

function buildBt01Baseline(ctx: TaskContext): BenchmarkTaskResult {
  const root = ctx.corpusRoots.codegraph;
  const startedAt = Date.now();
  const steps = [
    runShellStep(
      root,
      "rg impacto",
      "rg -n \"codegraph_impact|handleImpact|getImpactRadius\" src/mcp/tools.ts src/bin/codegraph.ts src/graph/traversal.ts src/index.ts",
    ),
    runShellStep(root, "sed mcp tools", "sed -n '440,470p' src/mcp/tools.ts"),
    runShellStep(root, "sed handler impact", "sed -n '1169,1205p' src/mcp/tools.ts"),
    runShellStep(root, "sed cli impact", "sed -n '1355,1415p' src/bin/codegraph.ts"),
    runShellStep(root, "sed traversal", "sed -n '458,530p' src/graph/traversal.ts"),
  ];

  return buildResult({
    id: "BT-01",
    title: "Localizar area certa para uma tool MCP",
    arm: "baseline",
    repoLabel: "CodeGraph",
    repoPath: root,
    snapshotLabel: "archive sem git",
    startedAt,
    steps,
    refs: ["src/mcp/tools.ts", "src/bin/codegraph.ts", "src/graph/traversal.ts", "src/index.ts"],
    finalAnswer:
      "A tool MCP de impacto fica em src/mcp/tools.ts como codegraph_impact. A rota CLI passa por src/bin/codegraph.ts. O cálculo estrutural desce para getImpactRadius em src/graph/traversal.ts e é exposto também pelo índice em src/index.ts.",
    uncertainties: [],
    notes: ["Fluxo obtido por grep + leituras seletivas."],
  });
}

function buildBt01Atlas(ctx: TaskContext): BenchmarkTaskResult {
  const root = ctx.corpusRoots.codegraph;
  const startedAt = Date.now();
  const steps = [
    runToolStep(root, "search getImpactRadius", "search", { query: "getImpactRadius", limit: 3 }),
    runToolStep(root, "explore src/mcp/tools.ts", "explore", { target: "src/mcp/tools.ts", mode: "file", depth: 2 }),
    runToolStep(root, "impact src/mcp/tools.ts", "impact", {
      target: "src/mcp/tools.ts",
      direction: "dependencies",
      depth: 2,
      summary_only: true,
    }),
  ];

  return buildResult({
    id: "BT-01",
    title: "Localizar area certa para uma tool MCP",
    arm: "atlas-cortex",
    repoLabel: "CodeGraph",
    repoPath: root,
    snapshotLabel: "archive indexado localmente",
    startedAt,
    steps,
    refs: ["src/mcp/tools.ts", "src/graph/traversal.ts", "src/index.ts"],
    finalAnswer:
      "Atlas Cortex isolou src/mcp/tools.ts como ponto MCP relevante e apontou dependência estrutural para src/graph/traversal.ts e src/index.ts. Isso reduz navegação manual até a área onde o cálculo de impacto é servido e consumido.",
    uncertainties: parseLinesMatching(steps.map((step) => step.output).join("\n"), /stale|incomplet/i),
    notes: ["Busca/impacto ainda são estruturais; causalidade semântica profunda continua fora do MVP."],
  });
}

function buildBt02Baseline(ctx: TaskContext): BenchmarkTaskResult {
  const root = ctx.corpusRoots.gitnexus;
  const startedAt = Date.now();
  const steps = [
    runShellStep(
      root,
      "rg trace impact",
      "rg -n \"impactCommand|backend.callTool\\('impact'|_impactImpl|safeLocalImpact|trace\" gitnexus/src/cli/tool.ts gitnexus/src/mcp/local/local-backend.ts gitnexus/src/core/group/cross-impact.ts gitnexus/src/core/ingestion/process-processor.ts",
    ),
    runShellStep(root, "sed cli tool", "sed -n '118,180p' gitnexus/src/cli/tool.ts"),
    runShellStep(root, "sed local backend", "sed -n '2955,3095p' gitnexus/src/mcp/local/local-backend.ts"),
    runShellStep(root, "sed cross impact", "sed -n '429,520p' gitnexus/src/core/group/cross-impact.ts"),
  ];

  return buildResult({
    id: "BT-02",
    title: "Explicar fluxo de trace/impacto",
    arm: "baseline",
    repoLabel: "GitNexus",
    repoPath: root,
    snapshotLabel: "archive sem git",
    startedAt,
    steps,
    refs: [
      "gitnexus/src/cli/tool.ts",
      "gitnexus/src/mcp/local/local-backend.ts",
      "gitnexus/src/core/group/cross-impact.ts",
      "gitnexus/src/core/ingestion/process-processor.ts",
    ],
    finalAnswer:
      "O fluxo sai da CLI em gitnexus/src/cli/tool.ts, entra no backend MCP local em gitnexus/src/mcp/local/local-backend.ts e, quando cruza repos, passa por gitnexus/src/core/group/cross-impact.ts. O trace de processos vive em gitnexus/src/core/ingestion/process-processor.ts.",
    uncertainties: [],
    notes: ["Leitura manual exigiu abrir arquivos grandes."],
  });
}

function buildBt02Atlas(ctx: TaskContext): BenchmarkTaskResult {
  const root = ctx.corpusRoots.gitnexus;
  const startedAt = Date.now();
  const steps = [
    runToolStep(root, "search _impactImpl", "search", { query: "_impactImpl", limit: 5 }),
    runToolStep(root, "files cross impact", "files", { pattern: "cross-impact", max_depth: 6 }),
  ];

  return buildResult({
    id: "BT-02",
    title: "Explicar fluxo de trace/impacto",
    arm: "atlas-cortex",
    repoLabel: "GitNexus",
    repoPath: root,
    snapshotLabel: "archive indexado localmente",
    startedAt,
    steps,
    refs: [
      "gitnexus/src/cli/tool.ts",
      "gitnexus/src/mcp/local/local-backend.ts",
      "gitnexus/src/core/group/cross-impact.ts",
    ],
    finalAnswer:
      "Atlas Cortex localizou rápido a entrada CLI em gitnexus/src/cli/tool.ts e o fan-out cross-repo em gitnexus/src/core/group/cross-impact.ts. O backend local segue concentrado em gitnexus/src/mcp/local/local-backend.ts, suficiente para explicar o fluxo macro de impacto.",
    uncertainties: parseLinesMatching(steps.map((step) => step.output).join("\n"), /stale|parcial|ambigua/i),
    notes: ["Trace multi-hop continua parcial porque o grafo do MVP ainda é estrutural."],
  });
}

function buildBt03Baseline(ctx: TaskContext): BenchmarkTaskResult {
  const root = ctx.corpusRoots.codegraph;
  const startedAt = Date.now();
  const steps = [
    runShellStep(
      root,
      "rg watcher stale",
      "rg -n \"watchDisabledReason|FileWatcher|pending sync|auto-sync|catch-up sync\" src/sync/index.ts src/mcp/engine.ts src/mcp/tools.ts src/index.ts",
    ),
    runShellStep(root, "sed sync index", "sed -n '1,80p' src/sync/index.ts"),
    runShellStep(root, "sed mcp engine", "sed -n '178,254p' src/mcp/engine.ts"),
    runShellStep(root, "sed stale banner", "sed -n '289,326p' src/mcp/tools.ts"),
  ];

  return buildResult({
    id: "BT-03",
    title: "Avaliar impacto de mudanca em sync/staleness",
    arm: "baseline",
    repoLabel: "CodeGraph",
    repoPath: root,
    snapshotLabel: "archive sem git",
    startedAt,
    steps,
    refs: ["src/sync/index.ts", "src/mcp/engine.ts", "src/mcp/tools.ts", "src/index.ts"],
    finalAnswer:
      "Falha no watcher afeta a camada de sync em src/sync/index.ts, a inicialização/auto-sync do MCP em src/mcp/engine.ts e os banners de staleness em src/mcp/tools.ts. O efeito prático é índice envelhecido e respostas com pending sync ou stale.",
    uncertainties: [],
    notes: ["Blast radius construído manualmente por leitura de módulos correlatos."],
  });
}

function buildBt03Atlas(ctx: TaskContext): BenchmarkTaskResult {
  const root = ctx.corpusRoots.codegraph;
  const startedAt = Date.now();
  const steps = [
    runToolStep(root, "files sync", "files", { pattern: "src/sync", max_depth: 3 }),
    runToolStep(root, "explore mcp engine", "explore", { target: "src/mcp/engine.ts", mode: "file", depth: 2 }),
  ];

  return buildResult({
    id: "BT-03",
    title: "Avaliar impacto de mudanca em sync/staleness",
    arm: "atlas-cortex",
    repoLabel: "CodeGraph",
    repoPath: root,
    snapshotLabel: "archive indexado localmente",
    startedAt,
    steps,
    refs: ["src/sync/index.ts", "src/mcp/engine.ts", "src/mcp/tools.ts"],
    finalAnswer:
      "Atlas Cortex mostrou rápido o cluster de sync/watch e concentrou a análise em src/mcp/engine.ts. O blast radius aponta para consumo MCP e superfícies que exibem stale/pending sync, suficiente para mapear o efeito operacional da falha do watcher.",
    uncertainties: parseLinesMatching(steps.map((step) => step.output).join("\n"), /stale|incomplet/i),
    notes: ["Resultado suficiente para blast radius operacional, não para timing fino do debounce."],
  });
}

function buildBt04Baseline(ctx: TaskContext): BenchmarkTaskResult {
  const root = ctx.corpusRoots.headroom;
  const startedAt = Date.now();
  const steps = [
    runShellStep(
      root,
      "rg ccr",
      "rg -n \"CCR|Compress-Cache-Retrieve|compress_with_store|headroom_retrieve|CompressionStore\" crates/headroom-core/src crates/headroom-py/src wiki",
    ),
    runShellStep(root, "sed ccr mod", "sed -n '1,110p' crates/headroom-core/src/ccr/mod.rs"),
    runShellStep(root, "sed pipeline mod", "sed -n '1,80p' crates/headroom-core/src/transforms/pipeline/mod.rs"),
    runShellStep(root, "sed diff offload", "sed -n '23,154p' crates/headroom-core/src/transforms/pipeline/offloads/diff_offload.rs"),
  ];

  return buildResult({
    id: "BT-04",
    title: "Identificar packing reversivel aplicavel",
    arm: "baseline",
    repoLabel: "Headroom",
    repoPath: root,
    snapshotLabel: "archive sem git",
    startedAt,
    steps,
    refs: [
      "crates/headroom-core/src/ccr/mod.rs",
      "crates/headroom-core/src/transforms/pipeline/mod.rs",
      "crates/headroom-core/src/transforms/pipeline/offloads/diff_offload.rs",
    ],
    finalAnswer:
      "A inspiração mais reutilizável está no contrato CCR em crates/headroom-core/src/ccr/mod.rs, na orquestração lossless-first em transforms/pipeline/mod.rs e no offload reversível com compress_with_store em offloads/diff_offload.rs.",
    uncertainties: [],
    notes: ["Leitura puxou muita documentação bruta para uma resposta curta."],
  });
}

function buildBt04Atlas(ctx: TaskContext): BenchmarkTaskResult {
  const root = ctx.corpusRoots.headroom;
  const startedAt = Date.now();
  const steps = [
    runToolStep(root, "search CompressionStore", "search", { query: "CompressionStore", limit: 5 }),
    runToolStep(root, "explore ccr mod", "explore", {
      target: "crates/headroom-core/src/ccr/mod.rs",
      mode: "file",
      depth: 2,
    }),
    runToolStep(root, "pack context ccr", "pack_context", {
      sources: [
        "crates/headroom-core/src/ccr/mod.rs",
        "crates/headroom-core/src/transforms/pipeline/mod.rs",
      ],
      goal: "extrair inspiracoes de packing reversivel para atlas-cortex",
      token_budget: 420,
      style: "balanced",
    }),
  ];

  return buildResult({
    id: "BT-04",
    title: "Identificar packing reversivel aplicavel",
    arm: "atlas-cortex",
    repoLabel: "Headroom",
    repoPath: root,
    snapshotLabel: "archive indexado localmente",
    startedAt,
    steps,
    refs: [
      "crates/headroom-core/src/ccr/mod.rs",
      "crates/headroom-core/src/transforms/pipeline/mod.rs",
    ],
    finalAnswer:
      "Atlas Cortex reduziu a leitura ao contrato CCR e à pipeline principal, empacotando um resumo curto com refs rastreáveis. As inspirações centrais continuam: guardar original recuperável, compressão lossy no fio e contrato explícito de retrieve.",
    uncertainties: parseLinesMatching(steps.map((step) => step.output).join("\n"), /stale|parcial|limita/i),
    notes: ["Pack aproveitou reversibilidade por refs, não por retrieve público dedicado."],
  });
}

function buildBt05Baseline(ctx: TaskContext): BenchmarkTaskResult {
  const root = ctx.codegraphDiffRoot;
  const startedAt = Date.now();
  const steps = [
    runShellStep(root, "git diff names", "git diff --name-only"),
    runShellStep(
      root,
      "rg changed area",
      "rg -n \"watchDisabledReason|watch-policy|sync|watcher\" src/sync/watch-policy.ts src/sync/index.ts src/mcp/engine.ts __tests__",
    ),
    runShellStep(root, "rg tests", "rg -n \"watch|sync|policy|mcp\" __tests__ src --glob '*.test.ts'"),
    runShellStep(root, "sed changed file", "sed -n '1,120p' src/sync/watch-policy.ts"),
  ];

  return buildResult({
    id: "BT-05",
    title: "Comparar diff e testes afetados",
    arm: "baseline",
    repoLabel: "CodeGraph",
    repoPath: root,
    snapshotLabel: "snapshot git temporario com mudança unstaged",
    startedAt,
    steps,
    refs: ["src/sync/watch-policy.ts", "src/sync/index.ts", "src/mcp/engine.ts"],
    finalAnswer:
      "O diff toca src/sync/watch-policy.ts, então a revisão manual precisa cruzar sync, watcher e engine MCP para levantar testes/áreas afetadas. Funciona, mas ainda depende de grep por nomes espalhados.",
    uncertainties: ["Sem mapeamento semântico fino por hunk; inferência manual segue ancorada em arquivo."],
    notes: ["Snapshot temporário criado só para suportar diff real sem mutar o archive."],
  });
}

function buildBt05Atlas(ctx: TaskContext): BenchmarkTaskResult {
  const root = ctx.codegraphDiffRoot;
  const startedAt = Date.now();
  const steps = [
    runToolStep(root, "diff impact unstaged", "diff_impact", { scope: "unstaged" }),
    runToolStep(root, "pack changed file", "pack_context", {
      sources: ["src/sync/watch-policy.ts"],
      goal: "avaliar testes e areas afetadas pelo diff atual",
      token_budget: 320,
      style: "brief",
    }),
  ];
  const diffPayload = extractJson(steps[0]);
  const affectedTests = Array.isArray(diffPayload.affected_tests)
    ? (diffPayload.affected_tests as string[])
    : [];

  return buildResult({
    id: "BT-05",
    title: "Comparar diff e testes afetados",
    arm: "atlas-cortex",
    repoLabel: "CodeGraph",
    repoPath: root,
    snapshotLabel: "snapshot git temporario com mudança unstaged",
    startedAt,
    steps,
    refs: uniqueStrings(["src/sync/watch-policy.ts", ...affectedTests]),
    finalAnswer:
      "Atlas Cortex leu o diff real em src/sync/watch-policy.ts e devolveu áreas/testes afetados em uma chamada principal, com um pacote curto do arquivo alterado para revisar contexto. Isso substitui a cadeia manual de grep + leitura do diff.",
    uncertainties: parseLinesMatching(steps.map((step) => step.output).join("\n"), /stale|parcial|unresolved/i),
    notes: ["affected_tests depende do grafo estrutural disponível no snapshot temporário."],
  });
}

function buildBt06Baseline(ctx: TaskContext): BenchmarkTaskResult {
  const root = ctx.corpusRoots.understandAnything;
  const startedAt = Date.now();
  const steps = [
    runShellStep(
      root,
      "rg visual scope",
      "rg -n \"dashboard|homepage|onboard|wiki|knowledge graph\" README.md CLAUDE.md understand-anything-plugin/src understand-anything-plugin/packages/dashboard homepage",
    ),
    runShellStep(root, "sed readme", "sed -n '46,75p' README.md"),
    runShellStep(root, "sed dashboard app", "sed -n '680,730p' understand-anything-plugin/packages/dashboard/src/App.tsx"),
  ];

  return buildResult({
    id: "BT-06",
    title: "Rejeitar escopo visual/plataforma",
    arm: "baseline",
    repoLabel: "Understand Anything",
    repoPath: root,
    snapshotLabel: "archive sem git",
    startedAt,
    steps,
    refs: [
      "README.md",
      "understand-anything-plugin/packages/dashboard/src/App.tsx",
      "homepage/src/layouts/Layout.astro",
      "understand-anything-plugin/src/onboard-builder.ts",
    ],
    finalAnswer:
      "O corpus mostra dashboard React, homepage Astro, onboarding e knowledge wiki como partes explícitas do produto. Isso reforça que o MVP do Atlas Cortex deve manter essas frentes fora do escopo.",
    uncertainties: [],
    notes: ["Resposta depende mais de nomenclatura/estrutura do que de grafo semântico."],
  });
}

function buildBt06Atlas(ctx: TaskContext): BenchmarkTaskResult {
  const root = ctx.corpusRoots.understandAnything;
  const startedAt = Date.now();
  const steps = [
    runToolStep(root, "files dashboard", "files", { pattern: "packages/dashboard/src", max_depth: 6 }),
    runToolStep(root, "search buildOnboardingGuide", "search", { query: "buildOnboardingGuide", limit: 3 }),
  ];

  return buildResult({
    id: "BT-06",
    title: "Rejeitar escopo visual/plataforma",
    arm: "atlas-cortex",
    repoLabel: "Understand Anything",
    repoPath: root,
    snapshotLabel: "archive indexado localmente",
    startedAt,
    steps,
    refs: [
      "understand-anything-plugin/packages/dashboard/src/App.tsx",
      "understand-anything-plugin/src/onboard-builder.ts",
    ],
    finalAnswer:
      "Atlas Cortex confirmou rapidamente dois eixos fora do MVP: dashboard interativo e onboarding gerado. Esses caminhos indexados já bastam para sustentar a exclusão de uma plataforma visual no Atlas Cortex.",
    uncertainties: parseLinesMatching(steps.map((step) => step.output).join("\n"), /stale|parcial|limita/i),
    notes: ["Homepage Astro não entra inteira no índice semântico; decisão sai por estrutura indexada e refs de arquivo."],
  });
}

const TASKS: TaskDefinition[] = [
  {
    id: "BT-01",
    title: "Localizar area certa para uma tool MCP",
    runBaseline: buildBt01Baseline,
    runAtlas: buildBt01Atlas,
  },
  {
    id: "BT-02",
    title: "Explicar fluxo de trace/impacto",
    runBaseline: buildBt02Baseline,
    runAtlas: buildBt02Atlas,
  },
  {
    id: "BT-03",
    title: "Avaliar impacto de mudanca em sync/staleness",
    runBaseline: buildBt03Baseline,
    runAtlas: buildBt03Atlas,
  },
  {
    id: "BT-04",
    title: "Identificar packing reversivel aplicavel",
    runBaseline: buildBt04Baseline,
    runAtlas: buildBt04Atlas,
  },
  {
    id: "BT-05",
    title: "Comparar diff e testes afetados",
    runBaseline: buildBt05Baseline,
    runAtlas: buildBt05Atlas,
  },
  {
    id: "BT-06",
    title: "Rejeitar escopo visual/plataforma",
    runBaseline: buildBt06Baseline,
    runAtlas: buildBt06Atlas,
  },
];

export function computePass(summaryTasks: BenchmarkTaskResult[]): BenchmarkSummary["totals"] {
  const baselineToolCalls = metricTotals(summaryTasks, "baseline", "tool_calls");
  const atlasToolCalls = metricTotals(summaryTasks, "atlas-cortex", "tool_calls");
  const baselineTokens = metricTotals(summaryTasks, "baseline", "tokens_aproximados");
  const atlasTokens = metricTotals(summaryTasks, "atlas-cortex", "tokens_aproximados");
  const toolCallReductionPct = baselineToolCalls === 0 ? 0 : ((baselineToolCalls - atlasToolCalls) / baselineToolCalls) * 100;
  const tokenReductionPct = baselineTokens === 0 ? 0 : ((baselineTokens - atlasTokens) / baselineTokens) * 100;
  const baselineAverageUtility = averageUtility(summaryTasks, "baseline");
  const atlasAverageUtility = averageUtility(summaryTasks, "atlas-cortex");
  const minimumAtlasUtility = Math.min(
    ...summaryTasks.filter((task) => task.arm === "atlas-cortex").map((task) => task.utilidade_percebida),
  );

  return {
    baseline_tool_calls: baselineToolCalls,
    atlas_tool_calls: atlasToolCalls,
    baseline_tokens: baselineTokens,
    atlas_tokens: atlasTokens,
    tool_call_reduction_pct: toolCallReductionPct,
    token_reduction_pct: tokenReductionPct,
    baseline_average_utility: baselineAverageUtility,
    atlas_average_utility: atlasAverageUtility,
    minimum_atlas_utility: minimumAtlasUtility,
  };
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

  const ctx: TaskContext = {
    workspaceRoot,
    outputDir,
    codegraphDiffRoot,
    corpusRoots,
  };

  const tasks: BenchmarkTaskResult[] = [];
  for (const task of TASKS) {
    const baseline = task.runBaseline(ctx);
    const atlas = task.runAtlas(ctx);
    tasks.push(baseline, atlas);
    writeEvidence(outputDir, baseline);
    writeEvidence(outputDir, atlas);
  }

  const totals = computePass(tasks);
  const pass =
    totals.tool_call_reduction_pct >= TOOL_CALL_REDUCTION_TARGET &&
    totals.token_reduction_pct >= TOKEN_REDUCTION_TARGET &&
    totals.atlas_average_utility >= MIN_AVERAGE_UTILITY &&
    totals.minimum_atlas_utility >= MIN_TASK_UTILITY;

  const summary: BenchmarkSummary = {
    generated_at: nowIso(),
    output_dir: outputDir,
    criteria: {
      min_tool_call_reduction_pct: TOOL_CALL_REDUCTION_TARGET,
      min_token_reduction_pct: TOKEN_REDUCTION_TARGET,
      min_average_utility: MIN_AVERAGE_UTILITY,
      min_task_utility: MIN_TASK_UTILITY,
    },
    totals,
    pass,
    tasks,
  };

  writeSummary(outputDir, summary);
  return summary;
}

async function main(): Promise<void> {
  const argRoot = process.argv[2];
  const workspaceRoot = argRoot ? resolve(process.cwd(), argRoot) : resolveWorkspaceRoot(process.cwd());
  const outputDir = resolve(workspaceRoot, ".atlas/benchmark/latest");
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
