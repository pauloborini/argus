import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const cli = join(root, "packages", "cortex", "dist", "cli.js");
const configured = process.env.CORTEX_HOMOLOGATION_REPOS?.split(":").filter(Boolean);
const candidates = configured ?? [
  resolve(root, "../atlas-workflow"),
  resolve(root, "../paytrainer-app"),
  join(root, ".app-vault", "archive", "headroom"),
];
const targets = candidates.filter(existsSync);

if (targets.length < 2) {
  throw new Error(
    "Homologação exige pelo menos 2 repos. Defina CORTEX_HOMOLOGATION_REPOS com paths separados por `:`.",
  );
}

const ignored = new Set([
  ".git",
  ".cortex",
  ".dart_tool",
  ".idea",
  ".next",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target",
]);
const results = [];

function runCliJson(args, cwd) {
  const raw = execFileSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 256 * 1024 * 1024,
  });
  return JSON.parse(raw);
}

const MEANINGFUL_KINDS = new Set([
  "function",
  "method",
  "class",
  "interface",
  "struct",
  "enum",
  "type",
]);

// Sonda de retrieval real: prova que o índice não só existe, mas responde
// explore/search úteis sobre um arquivo real do repo. Sem isto, homologação
// só atesta indexação, nunca utilidade.
function probeRetrieval(cwd) {
  const files = runCliJson(["files", "--max-depth", "4"], cwd);
  const tree = Array.isArray(files.tree) ? files.tree : [];
  const probeFile = tree.find((entry) => (entry?.symbol_counts?.total ?? 0) > 0)?.path;
  if (!probeFile) {
    return {
      verdict: "degraded",
      reason: "Nenhum arquivo indexado com símbolos para sondar.",
      probe_file: null,
      explore_symbols: 0,
      search_query: null,
      search_hit: false,
      confidence: null,
    };
  }

  const explore = runCliJson(["explore", probeFile, "--mode", "file"], cwd);
  const centralSymbols = Array.isArray(explore.central_symbols) ? explore.central_symbols : [];
  const probeSymbol =
    centralSymbols.find((sym) => MEANINGFUL_KINDS.has(sym?.kind)) ?? centralSymbols[0];

  let searchHit = false;
  let searchQuery = null;
  if (probeSymbol?.name) {
    searchQuery = probeSymbol.name;
    const search = runCliJson(["search", searchQuery, "--limit", "5"], cwd);
    const candidates = Array.isArray(search.candidates) ? search.candidates : [];
    searchHit = candidates.some(
      (cand) => cand?.name === probeSymbol.name || cand?.path === probeFile,
    );
  }

  const useful = centralSymbols.length > 0 && searchHit && explore.state !== "falha";
  return {
    verdict: useful ? "useful" : "degraded",
    reason: useful
      ? null
      : "explore sem símbolos centrais ou search não reencontrou o símbolo sondado.",
    probe_file: probeFile,
    explore_symbols: centralSymbols.length,
    search_query: searchQuery,
    search_hit: searchHit,
    confidence: explore.confidence ?? null,
  };
}

for (const source of targets) {
  const temp = mkdtempSync(join(tmpdir(), "atlas-cortex-homologation-"));
  const target = join(temp, basename(source));
  try {
    cpSync(source, target, {
      recursive: true,
      filter(path) {
        return !path
          .split(/[\\/]/)
          .some((part) => ignored.has(part));
      },
    });

    execFileSync(process.execPath, [cli, "init"], { cwd: target, stdio: "pipe" });
    const startedAt = Date.now();
    execFileSync(process.execPath, [cli, "index"], { cwd: target, stdio: "pipe" });
    const durationMs = Date.now() - startedAt;
    const statusRaw = execFileSync(process.execPath, [cli, "status"], {
      cwd: target,
      encoding: "utf8",
    });
    const status = JSON.parse(statusRaw);
    if (status.state === "falha" || status.initialized !== true) {
      throw new Error(`Status inválido em ${source}: ${statusRaw}`);
    }
    const retrieval = probeRetrieval(target);
    results.push({
      repository: basename(source),
      duration_ms: durationMs,
      file_count: status.file_count ?? null,
      coverage_by_language: status.coverage_by_language,
      staleness: status.staleness,
      state: status.state,
      retrieval,
    });
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

const evidenceDir = join(root, ".atlas", "homologation");
mkdirSync(evidenceDir, { recursive: true });
const payload = {
  generated_at: new Date().toISOString(),
  runtime_version: JSON.parse(
    readFileSync(join(root, "packages", "cortex", "package.json"), "utf8"),
  ).version,
  repositories: results,
  verdict: (() => {
    const indexed = results.every(
      (item) => item.state !== "falha" && item.staleness !== "stale",
    );
    if (!indexed) {
      return "failed";
    }
    return results.every((item) => item.retrieval.verdict === "useful")
      ? "passed"
      : "incomplete";
  })(),
};
writeFileSync(join(evidenceDir, "latest.json"), `${JSON.stringify(payload, null, 2)}\n`);
writeFileSync(
  join(evidenceDir, "LATEST.md"),
  [
    "# Homologação ampliada",
    "",
    `- Data: ${payload.generated_at}`,
    `- Runtime: ${payload.runtime_version}`,
    `- Veredito: ${payload.verdict}`,
    "",
    "| Repositório | Duração | Staleness | Estado | Retrieval | Sonda |",
    "|---|---:|---|---|---|---|",
    ...results.map(
      (item) =>
        `| ${item.repository} | ${item.duration_ms} ms | ${item.staleness} | ${item.state} | ${item.retrieval.verdict} | ${item.retrieval.probe_file ?? "—"} (${item.retrieval.explore_symbols} sym, search ${item.retrieval.search_hit ? "hit" : "miss"}) |`,
    ),
    "",
  ].join("\n"),
);

if (payload.verdict === "failed") {
  throw new Error("Homologação ampliada falhou: indexação inválida ou índice stale.");
}
if (payload.verdict === "incomplete") {
  const degraded = results
    .filter((item) => item.retrieval.verdict !== "useful")
    .map((item) => `${item.repository} (${item.retrieval.reason})`)
    .join("; ");
  throw new Error(`Homologação incompleta: retrieval degradado em ${degraded}.`);
}
console.log(
  `Homologação aprovada em ${results.length} repositórios com retrieval útil sondado.`,
);
