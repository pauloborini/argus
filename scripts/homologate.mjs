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
    results.push({
      repository: basename(source),
      duration_ms: durationMs,
      file_count: status.file_count ?? null,
      coverage_by_language: status.coverage_by_language,
      staleness: status.staleness,
      state: status.state,
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
  verdict: results.every((item) => item.state !== "falha" && item.staleness !== "stale")
    ? "passed"
    : "failed",
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
    "| Repositório | Duração | Staleness | Estado |",
    "|---|---:|---|---|",
    ...results.map(
      (item) =>
        `| ${item.repository} | ${item.duration_ms} ms | ${item.staleness} | ${item.state} |`,
    ),
    "",
  ].join("\n"),
);

if (payload.verdict !== "passed") {
  throw new Error("Homologação ampliada falhou.");
}
console.log(`Homologação aprovada em ${results.length} repositórios.`);
