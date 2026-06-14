import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverFiles } from "../src/discovery/walk.js";
import { gitDelta } from "../src/discovery/git-delta.js";
import { buildDiscoveryManifest, fingerprintDiscoveredFiles } from "../src/discovery/fingerprint.js";
import { computeManifestStaleness } from "../src/discovery/staleness.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

function initGitRepo(cwd: string): void {
  git(cwd, ["init", "-q"]);
  git(cwd, ["config", "user.email", "test@example.com"]);
  git(cwd, ["config", "user.name", "Test"]);
  git(cwd, ["config", "commit.gpgsign", "false"]);
}

function trackedPaths(cwd: string): string[] {
  return git(cwd, ["ls-files", "-z"])
    .split("\0")
    .filter((token) => token.length > 0)
    .sort();
}

describe("discovery — respeito a .gitignore", () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  function fixtureGit(): string {
    tempDir = mkdtempSync(join(tmpdir(), "cortex-gitignore-"));
    const root = tempDir;
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "cache"), { recursive: true });
    // Versionados.
    writeFileSync(join(root, ".gitignore"), "secret.env\ncache/\n*.log\n", "utf-8");
    writeFileSync(join(root, "README.md"), "# repo\n", "utf-8");
    writeFileSync(join(root, "src", "main.ts"), "export const main = 1;\n", "utf-8");
    // Untracked ignorados pelo .gitignore.
    writeFileSync(join(root, "secret.env"), "TOKEN=shh\n", "utf-8");
    writeFileSync(join(root, "cache", "out.js"), "noop\n", "utf-8");
    writeFileSync(join(root, "debug.log"), "trace\n", "utf-8");
    // Untracked não-ignorado.
    writeFileSync(join(root, "src", "new.ts"), "export const fresh = 2;\n", "utf-8");
    // Untracked coberto por shouldIgnore (lista fixa), independente do .gitignore.
    writeFileSync(join(root, "app.min.js"), "noop\n", "utf-8");

    initGitRepo(root);
    git(root, ["add", "README.md", "src/main.ts", ".gitignore"]);
    git(root, ["commit", "-q", "-m", "init"]);
    return root;
  }

  it("não indexa segredo gitignored (.env), dir ignorado nem *.log", () => {
    const root = fixtureGit();
    const paths = discoverFiles(root, { respect_gitignore: true }).files.map((f) => f.relative_path);
    expect(paths).toEqual([".gitignore", "README.md", "src/main.ts", "src/new.ts"]);
    expect(paths).not.toContain("secret.env");
    expect(paths).not.toContain("cache/out.js");
    expect(paths).not.toContain("debug.log");
    expect(paths).not.toContain("app.min.js"); // shouldIgnore
  });

  it("respect_gitignore=false inclui os ignorados, mas shouldIgnore ainda corta", () => {
    const root = fixtureGit();
    const paths = discoverFiles(root, { respect_gitignore: false }).files.map((f) => f.relative_path);
    expect(paths).toContain("secret.env");
    expect(paths).toContain("cache/out.js");
    expect(paths).toContain("debug.log");
    expect(paths).not.toContain("app.min.js"); // lista fixa permanece
  });

  it("invariante walk ≡ git-delta: mesmo conjunto indexado (respect=true)", () => {
    const root = fixtureGit();
    const walkSet = discoverFiles(root, { respect_gitignore: true })
      .files.map((f) => f.relative_path)
      .sort();

    // Conjunto git-delta = tracked ∪ untracked-não-ignorado (delta desde HEAD).
    const delta = gitDelta(root, "HEAD", { respect_gitignore: true });
    expect(delta).not.toBeNull();
    const deltaSet = [
      ...trackedPaths(root),
      ...delta!.changed.map((f) => f.relative_path),
    ]
      .filter((p, i, arr) => arr.indexOf(p) === i)
      .sort();

    expect(deltaSet).toEqual(walkSet);
  });

  it("arquivo tracked-e-gitignored permanece indexado em ambos os caminhos", () => {
    tempDir = mkdtempSync(join(tmpdir(), "cortex-gitignore-tracked-"));
    const root = tempDir;
    writeFileSync(join(root, "config.env"), "A=1\n", "utf-8");
    writeFileSync(join(root, "main.ts"), "export const x = 1;\n", "utf-8");
    initGitRepo(root);
    git(root, ["add", "config.env", "main.ts"]);
    git(root, ["commit", "-q", "-m", "init"]);
    // .gitignore passa a cobrir config.env DEPOIS de versionado.
    writeFileSync(join(root, ".gitignore"), "*.env\n", "utf-8");
    git(root, ["add", ".gitignore"]);
    git(root, ["commit", "-q", "-m", "ignore env"]);

    const walkPaths = discoverFiles(root, { respect_gitignore: true }).files.map((f) => f.relative_path);
    expect(walkPaths).toContain("config.env"); // git só ignora untracked
    // git-delta vê config.env como tracked.
    expect(trackedPaths(root)).toContain("config.env");
  });

  it("fallback best-effort sem git: walk lê o .gitignore da raiz via lib", () => {
    tempDir = mkdtempSync(join(tmpdir(), "cortex-gitignore-nogit-"));
    const root = tempDir;
    writeFileSync(join(root, ".gitignore"), "secret.env\n", "utf-8");
    writeFileSync(join(root, "secret.env"), "TOKEN=shh\n", "utf-8");
    writeFileSync(join(root, "keep.ts"), "export const k = 1;\n", "utf-8");

    const paths = discoverFiles(root, { respect_gitignore: true }).files.map((f) => f.relative_path);
    expect(paths).toContain("keep.ts");
    expect(paths).toContain(".gitignore");
    expect(paths).not.toContain("secret.env");
  });

  it("staleness não dá falso stale quando usa a mesma flag do index", () => {
    const root = fixtureGit();
    const discovery = discoverFiles(root, { respect_gitignore: true });
    const manifest = buildDiscoveryManifest(root, fingerprintDiscoveredFiles(discovery.files));
    const result = computeManifestStaleness(root, manifest, { respect_gitignore: true });
    expect(result.staleness).toBe("fresh");
    expect(result.pending_files_count).toBe(0);
  });
});
