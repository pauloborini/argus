import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ignore, { type Ignore } from "ignore";
import { isGitRepository } from "./git-delta.js";
import { normalizeRelativePath } from "./ignores.js";

/**
 * Contexto de exclusão por `.gitignore`, construído uma vez por discovery e
 * consultado pelo walk para decidir prune de diretório e omissão de arquivo.
 *
 * Em repo git delega ao engine nativo do git (equivalência exata com o que o
 * `git-delta` enxerga via `--exclude-standard`). Fora de git, cai em um parser
 * best-effort baseado na lib `ignore`, lendo apenas o `.gitignore` da raiz.
 */
export interface IgnoreContext {
  /** Verdadeiro se o diretório (relativo, normalizado) é totalmente ignorado. */
  isIgnoredDir(relativePath: string): boolean;
  /** Verdadeiro se o arquivo (relativo, normalizado) é ignorado. */
  isIgnoredFile(relativePath: string): boolean;
}

export interface BuildIgnoreContextOptions {
  /** Default `true`: respeita `.gitignore`. `false` desliga (lista fixa só). */
  respect_gitignore?: boolean;
}

const NOOP_CONTEXT: IgnoreContext = {
  isIgnoredDir: () => false,
  isIgnoredFile: () => false,
};

/**
 * Resolve o conjunto de paths ignorados pelo git, uma única vez, via engine
 * nativo. `--directory` colapsa diretórios totalmente ignorados em `dir/`
 * (permite prune de performance no walk); arquivos ignorados soltos vêm
 * individualmente. `-i --exclude-standard` aplica as mesmas regras
 * (`.gitignore` aninhado, `.git/info/exclude` e `core.excludesFile` global) que
 * o `git-delta` usa em `ls-files --others --exclude-standard`, garantindo a
 * invariante walk ≡ git-delta sobre a base `tracked ∪ untracked-não-ignorado`.
 */
function buildGitContext(rootPath: string): IgnoreContext {
  let raw: string;
  try {
    raw = execFileSync(
      "git",
      ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z", "--", "."],
      { cwd: rootPath, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
  } catch {
    // Sem listagem acessível: não bloqueia o discovery, apenas não filtra.
    return NOOP_CONTEXT;
  }

  const ignoredDirs = new Set<string>();
  const ignoredFiles = new Set<string>();
  for (const token of raw.split("\0").filter((entry) => entry.length > 0)) {
    if (token.endsWith("/")) {
      ignoredDirs.add(normalizeRelativePath(token.slice(0, -1)));
    } else {
      ignoredFiles.add(normalizeRelativePath(token));
    }
  }

  const underIgnoredDir = (relativePath: string): boolean => {
    const segments = relativePath.split("/");
    let prefix = "";
    for (let i = 0; i < segments.length - 1; i += 1) {
      prefix = prefix ? `${prefix}/${segments[i]}` : segments[i];
      if (ignoredDirs.has(prefix)) {
        return true;
      }
    }
    return false;
  };

  return {
    isIgnoredDir: (relativePath) =>
      ignoredDirs.has(relativePath) || underIgnoredDir(relativePath),
    isIgnoredFile: (relativePath) =>
      ignoredFiles.has(relativePath) || underIgnoredDir(relativePath),
  };
}

/**
 * Fallback best-effort para repos sem git: lê apenas o `.gitignore` da raiz com
 * a lib `ignore`. NÃO cobre `.gitignore` aninhado, `.git/info/exclude` nem
 * `core.excludesFile` global — limitação aceita, documentada. O caminho preciso
 * é via git ({@link buildGitContext}).
 */
function buildLibContext(rootPath: string): IgnoreContext {
  const gitignorePath = join(rootPath, ".gitignore");
  if (!existsSync(gitignorePath)) {
    return NOOP_CONTEXT;
  }

  let matcher: Ignore;
  try {
    matcher = ignore().add(readFileSync(gitignorePath, "utf8"));
  } catch {
    return NOOP_CONTEXT;
  }

  // `ignore.ignores` exige path relativo posix não-vazio sem `/` inicial.
  const test = (relativePath: string): boolean =>
    relativePath.length > 0 && matcher.ignores(relativePath);

  return {
    isIgnoredDir: test,
    isIgnoredFile: test,
  };
}

export function buildIgnoreContext(
  rootPath: string,
  options: BuildIgnoreContextOptions = {},
): IgnoreContext {
  const respect = options.respect_gitignore ?? true;
  if (!respect) {
    return NOOP_CONTEXT;
  }
  return isGitRepository(rootPath) ? buildGitContext(rootPath) : buildLibContext(rootPath);
}
