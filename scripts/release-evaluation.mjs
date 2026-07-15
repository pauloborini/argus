import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const cli = join(repoRoot, "packages", "argus", "dist", "cli.js");
const dreamEngineUrl = new URL("../packages/argus/dist/memory/dream-engine.js", import.meta.url);
const evidenceDir = join(repoRoot, ".argus", "release-evaluation");
const workDir = mkdtempSync(join(existsSync("/tmp") ? "/tmp" : tmpdir(), "argus-release-eval-"));

function runCli(args, cwd) {
  const started = performance.now();
  execFileSync(process.execPath, [cli, ...args], { cwd, stdio: "inherit" });
  return Math.round(performance.now() - started);
}

function timed(fn) {
  const started = performance.now();
  const result = fn();
  return Promise.resolve(result).then((value) => ({
    value,
    durationMs: Math.round(performance.now() - started),
  }));
}

function gate(name, command, status, durationMs, detail) {
  return { name, command, status, duration_ms: durationMs, detail };
}

try {
  if (!existsSync(cli)) {
    throw new Error("Build ausente: rode npm run build antes de release:eval.");
  }

  writeFileSync(join(workDir, "sample.ts"), "export function releaseEval() { return 42; }\n", "utf-8");
  runCli(["init"], workDir);
  runCli(["index"], workDir);
  runCli(["memory", "init"], workDir);
  writeFileSync(join(workDir, "note.md"), `# release eval\n\nrelease evaluation token ${Date.now()}\n`, "utf-8");
  runCli(["memory", "remember", readFileSync(join(workDir, "note.md"), "utf-8"), "--type", "decision"], workDir);

  const syncMs = runCli(["memory", "sync"], workDir);
  const searchMs = runCli(["memory", "search", "release evaluation"], workDir);
  const { DreamEngine } = await import(dreamEngineUrl);
  const { value: dream, durationMs: dreamMs } = await timed(() => DreamEngine.run(workDir, { dryRun: true }));

  execFileSync("npm", ["run", "test", "--workspace=@owerride/argus", "--", "release-privacy"], {
    cwd: repoRoot,
    stdio: "pipe",
  });
  execFileSync("npm", ["run", "test", "--workspace=@owerride/argus", "--", "memory/release-evaluation"], {
    cwd: repoRoot,
    stdio: "pipe",
  });

  const gates = [
    gate("memory_sync", "argus memory sync", "passed", syncMs, "local fixture"),
    gate("memory_search", "argus memory search", "passed", searchMs, "fts local"),
    gate(
      "dream_dry_run",
      "DreamEngine.run({ dryRun: true })",
      dream.state === "sucesso" && (dream.blocked_actions?.length ?? 0) === 0 ? "passed" : "incomplete",
      dreamMs,
      `state=${dream.state}; blocked=${dream.blocked_actions?.length ?? 0}; report=${dream.report_file ?? "none"}`,
    ),
  ];
  const verdict = gates.every((item) => item.status === "passed") ? "passed" : "incomplete";

  const report = {
    verdict,
    generated_at: new Date().toISOString(),
    gates,
    privacy: {
      network_opt_in_only: true,
      no_secret_in_log: true,
      gitignored_protected: true,
      workspace_confinement: true,
      opaque_handles: true,
      verified_by: "packages/argus/tests/release-privacy.test.ts",
    },
    degradation: {
      no_embeddings: true,
      no_llm: true,
      workspace_stale: false,
      note: "Performance orientativa; sem SLA. Valores variam por hardware.",
    },
    mcp_surface: { count: 12, remember: true, recall: true },
    performance_ms: {
      sync: syncMs,
      search: searchMs,
      dream_dry_run: dreamMs,
    },
  };

  mkdirSync(evidenceDir, { recursive: true });
  const evidencePath = join(evidenceDir, "latest.json");
  writeFileSync(evidencePath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
  console.log(`Release evaluation: ${report.verdict}`);
  console.log(`Evidence: ${evidencePath}`);
  console.log(JSON.stringify(report));
  if (report.verdict !== "passed") {
    process.exitCode = 1;
  }
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
