// Tool `diff_impact`: impacto provável do diff Git atual.
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { stubResponse } from "../../contracts/response-state.js";
import type { StructuralIndex } from "../../extraction/types.js";
import { uniqueByKey, fileMatchesTests, normalizeRelativePath } from "./common.js";
import type { ToolResponsePayload, DiffImpactArgs, IndexEnvelope, DiffImpactSymbol, DiffChangedHunk } from "./common.js";
import { buildImpactResponse } from "./impact.js";

function summarizeDiffImpactRisk(
  changedFileCount: number,
  changedSymbolCount: number,
  affectedAreaCount: number,
  affectedTestCount: number,
  unresolvedCount: number,
): string {
  if (changedFileCount === 0) {
    return "Nenhuma mudança local detectada no escopo solicitado.";
  }

  const magnitude =
    changedFileCount + affectedTestCount >= 10
      ? "alto"
      : changedFileCount + affectedTestCount >= 4
        ? "medio"
        : "baixo";
  return `Diff impact ${magnitude}: ${changedFileCount} arquivo(s) alterado(s), ${changedSymbolCount} símbolo(s) alterado(s), ${affectedAreaCount} área(s) afetada(s), ${affectedTestCount} teste(s) afetado(s) e ${unresolvedCount} arquivo(s) fora do grafo atual.`;
}

function resolveGitRoot(cwd: string): { root: string } | { error: string } {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf-8",
  });

  if (result.status !== 0) {
    return { error: "E_GIT_INVALID: Repositório Git inválido ou inacessível para diff_impact." };
  }

  const root = result.stdout.trim();
  if (!root) {
    return { error: "E_GIT_INVALID: Repositório Git inválido ou inacessível para diff_impact." };
  }

  return { root };
}

function collectGitPaths(cwd: string, args: string[]): { paths: string[] } | { error: string } {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf-8",
  });

  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    return {
      error: detail
        ? `E_GIT_DIFF_UNAVAILABLE: ${detail}`
        : "E_GIT_DIFF_UNAVAILABLE: Não foi possível ler o diff Git atual.",
    };
  }

  const paths = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return { paths };
}

function toWorkspaceRelativePath(cwd: string, gitRoot: string, gitPath: string): string | null {
  const workspaceRoot = realpathSync.native(cwd);
  const normalizedGitRoot = realpathSync.native(gitRoot);
  const absolutePath = resolve(normalizedGitRoot, gitPath);
  const workspaceRelative = normalizeRelativePath(relative(workspaceRoot, absolutePath));
  if (!workspaceRelative || workspaceRelative.startsWith("../")) {
    return null;
  }
  return workspaceRelative;
}

function collectGitText(cwd: string, args: string[]): { text: string } | { error: string } {
  const result = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    return {
      error: detail
        ? `E_GIT_DIFF_UNAVAILABLE: ${detail}`
        : "E_GIT_DIFF_UNAVAILABLE: Não foi possível ler o diff Git atual.",
    };
  }
  return { text: result.stdout };
}

function parseChangedHunks(cwd: string, gitRoot: string, diffText: string): DiffChangedHunk[] {
  const hunks: DiffChangedHunk[] = [];
  let currentPath: string | null = null;
  let previousPath: string | null = null;
  for (const line of diffText.split("\n")) {
    if (line.startsWith("--- a/")) {
      previousPath = toWorkspaceRelativePath(cwd, gitRoot, line.slice(6));
      continue;
    }
    if (line.startsWith("+++ b/")) {
      currentPath = toWorkspaceRelativePath(cwd, gitRoot, line.slice(6));
      continue;
    }
    if (line === "+++ /dev/null") {
      currentPath = previousPath;
      continue;
    }
    if (!currentPath || !line.startsWith("@@")) {
      continue;
    }
    const match = /-(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))?/.exec(line);
    if (!match) {
      continue;
    }
    const addedCount = Number(match[4] ?? "1");
    const usesRemovedRange = addedCount === 0;
    hunks.push({
      path: currentPath,
      start_line: Number(usesRemovedRange ? match[1] : match[3]),
      line_count: Math.max(1, Number(usesRemovedRange ? (match[2] ?? "1") : addedCount)),
    });
  }
  return hunks;
}

function readChangedFilesFromGit(
  cwd: string,
  args?: DiffImpactArgs,
): {
  changedFiles: string[];
  changedHunks: DiffChangedHunk[];
  scope: NonNullable<DiffImpactArgs["scope"]>;
} | { error: string } {
  const scope = args?.scope ?? "all";
  if (scope === "compare" && !args?.base_ref?.trim()) {
    return { error: "E_BASE_REF_REQUIRED: `base_ref` é obrigatório quando `scope=compare`." };
  }

  const gitRootResult = resolveGitRoot(cwd);
  if ("error" in gitRootResult) {
    return gitRootResult;
  }

  const gitRoot = gitRootResult.root;
  const collected = new Set<string>();
  const segments: string[][] = [];
  const diffSegments: string[][] = [];

  if (scope === "unstaged") {
    segments.push(["diff", "--name-only"]);
    segments.push(["ls-files", "--others", "--exclude-standard"]);
    diffSegments.push(["diff", "--unified=0", "--no-color"]);
  } else if (scope === "staged") {
    segments.push(["diff", "--cached", "--name-only"]);
    diffSegments.push(["diff", "--cached", "--unified=0", "--no-color"]);
  } else if (scope === "compare") {
    segments.push(["diff", "--name-only", `${args!.base_ref!.trim()}...HEAD`]);
    diffSegments.push(["diff", "--unified=0", "--no-color", `${args!.base_ref!.trim()}...HEAD`]);
  } else {
    segments.push(["diff", "--name-only"]);
    segments.push(["diff", "--cached", "--name-only"]);
    segments.push(["ls-files", "--others", "--exclude-standard"]);
    diffSegments.push(["diff", "--unified=0", "--no-color"]);
    diffSegments.push(["diff", "--cached", "--unified=0", "--no-color"]);
  }

  for (const segment of segments) {
    const output = collectGitPaths(gitRoot, segment);
    if ("error" in output) {
      return output;
    }
    for (const gitPath of output.paths) {
      const workspaceRelative = toWorkspaceRelativePath(cwd, gitRoot, gitPath);
      if (workspaceRelative) {
        collected.add(workspaceRelative);
      }
    }
  }

  const changedHunks: DiffChangedHunk[] = [];
  for (const segment of diffSegments) {
    const output = collectGitText(gitRoot, segment);
    if ("error" in output) {
      return output;
    }
    changedHunks.push(...parseChangedHunks(cwd, gitRoot, output.text));
  }

  return {
    changedFiles: Array.from(collected).sort((left, right) => left.localeCompare(right)),
    changedHunks,
    scope,
  };
}

function extractChangedSymbols(
  index: StructuralIndex,
  changedFiles: string[],
  changedHunks: DiffChangedHunk[],
): DiffImpactSymbol[] {
  const byPath = new Set(changedFiles);
  const hunksByPath = new Map<string, DiffChangedHunk[]>();
  for (const hunk of changedHunks) {
    const current = hunksByPath.get(hunk.path) ?? [];
    current.push(hunk);
    hunksByPath.set(hunk.path, current);
  }
  const symbols: DiffImpactSymbol[] = [];

  for (const file of index.files) {
    if (!byPath.has(file.relative_path)) {
      continue;
    }
    const hunks = hunksByPath.get(file.relative_path) ?? [];
    for (const symbol of file.symbols) {
      if (
        hunks.length > 0 &&
        !hunks.some((hunk) => {
          const hunkEnd = hunk.start_line + hunk.line_count - 1;
          return symbol.start_line <= hunkEnd && symbol.end_line >= hunk.start_line;
        })
      ) {
        continue;
      }
      symbols.push({
        name: symbol.name,
        path: file.relative_path,
        kind: symbol.kind,
      });
    }
  }

  return uniqueByKey(symbols, (item) => `${item.path}:${item.kind ?? ""}:${item.name}`);
}

function buildAffectedAreas(paths: string[]): string[] {
  const areas = paths.map((pathValue) => {
    const dir = normalizeRelativePath(dirname(pathValue));
    return dir === "." ? "." : dir;
  });
  return uniqueByKey(areas, (item) => item).sort((left, right) => left.localeCompare(right));
}

export function buildDiffImpactResponse(
  cwd: string,
  envelope: IndexEnvelope,
  args?: DiffImpactArgs,
): ToolResponsePayload {
  const diffResult = readChangedFilesFromGit(cwd, args);
  if ("error" in diffResult) {
    return {
      changed_files: [],
      changed_symbols: [],
      affected_areas: [],
      affected_tests: [],
      risk_summary: "",
      ...stubResponse("falha", diffResult.error),
    };
  }

  const changedFiles = diffResult.changedFiles;
  const baseAreas = buildAffectedAreas(changedFiles);

  if (envelope.state === "falha" || !envelope.structuralIndex) {
    return {
      changed_files: changedFiles,
      changed_symbols: [],
      affected_areas: baseAreas,
      affected_tests: [],
      risk_summary: summarizeDiffImpactRisk(
        changedFiles.length,
        0,
        baseAreas.length,
        0,
        changedFiles.length,
      ),
      ...stubResponse(envelope.state, envelope.message, {
        limitations: envelope.limitations,
        staleness_hint: envelope.staleness_hint,
      }),
    };
  }

  const index = envelope.structuralIndex;
  const changedSymbols = extractChangedSymbols(index, changedFiles, diffResult.changedHunks);
  const affectedPaths = new Set<string>(changedFiles);
  const affectedTests = new Set<string>();
  const limitations = new Set<string>();
  let unresolvedFiles = 0;
  let uncertaintyCount = 0;
  let partialCoverage = false;

  for (const changedFile of changedFiles) {
    const impactPayload = buildImpactResponse(cwd, envelope, {
      target: changedFile,
      direction: "dependents",
      depth: 3,
      include_tests: true,
    });

    if (impactPayload.state === "falha" || impactPayload.state === "ambigua") {
      unresolvedFiles += 1;
      continue;
    }

    for (const pathValue of (impactPayload.files as string[] | undefined) ?? []) {
      affectedPaths.add(pathValue);
      if (fileMatchesTests(pathValue)) {
        affectedTests.add(pathValue);
      }
      const language = index.files.find((entry) => entry.relative_path === pathValue)?.language;
      if (language ? index.coverage_by_language[language]?.coverage_level === "partial" : false) {
        partialCoverage = true;
      }
    }

    for (const pathValue of (impactPayload.tests as string[] | undefined) ?? []) {
      affectedTests.add(pathValue);
    }

    for (const limitation of (impactPayload.limitations as string[] | undefined) ?? []) {
      limitations.add(limitation);
    }

    const directAffected = Array.isArray(impactPayload.direct_affected)
      ? impactPayload.direct_affected.length
      : 0;
    const indirectAffected = Array.isArray(impactPayload.indirect_affected)
      ? impactPayload.indirect_affected.length
      : 0;

    if (impactPayload.state === "parcial") {
      uncertaintyCount += 1;
      if (directAffected + indirectAffected === 0) {
        unresolvedFiles += 1;
      }
    }
  }

  const affectedAreas = buildAffectedAreas(Array.from(affectedPaths));
  const riskSummary = summarizeDiffImpactRisk(
    changedFiles.length,
    changedSymbols.length,
    affectedAreas.length,
    affectedTests.size,
    unresolvedFiles,
  );
  const state =
    envelope.state === "stale"
      ? "stale"
      : unresolvedFiles > 0 || partialCoverage || uncertaintyCount > 0
        ? "parcial"
        : "sucesso";

  return {
    changed_files: changedFiles,
    changed_hunks: diffResult.changedHunks,
    changed_symbols: changedSymbols,
    affected_areas: affectedAreas,
    affected_tests: Array.from(affectedTests).sort((left, right) => left.localeCompare(right)),
    risk_summary: riskSummary,
    ...stubResponse(state, "Impacto provável do diff Git derivado do índice estrutural.", {
      limitations: Array.from(limitations),
      staleness_hint: envelope.staleness_hint,
    }),
  };
}
