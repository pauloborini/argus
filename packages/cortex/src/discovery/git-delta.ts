import { execFileSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import type { DiscoveredFile } from "./types.js";
import {
  DEFAULT_IGNORED_DIRECTORIES,
  DEFAULT_MAX_FILE_SIZE_BYTES,
  normalizeRelativePath,
  shouldIgnore,
} from "./ignores.js";
import type { DiscoveryLimitation } from "./walk.js";

export interface GitDeltaResult {
  /** Arquivos adicionados ou modificados, com metadados frescos do FS. */
  changed: DiscoveredFile[];
  /** Paths removidos (relativos, normalizados). */
  removed: string[];
  limitations: DiscoveryLimitation[];
}

export interface GitDeltaOptions {
  max_file_size_bytes?: number;
}

/**
 * Verdadeiro se `rootPath` está dentro de uma árvore de trabalho git utilizável.
 */
export function isGitRepository(rootPath: string): boolean {
  try {
    const out = execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: rootPath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim() === "true";
  } catch {
    return false;
  }
}

/**
 * Verdadeiro se `ref` resolve para um objeto git válido em `rootPath`.
 */
export function isValidGitRef(rootPath: string, ref: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
      cwd: rootPath,
      encoding: "utf8",
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve o delta de arquivos desde `sinceRef` até a árvore de trabalho atual
 * (commits + alterações não commitadas) via `git diff --name-status`. Pula o
 * walk completo do filesystem. Retorna `null` quando git não está disponível ou
 * o ref é inválido — o chamador deve cair para `discoverFiles` (walk completo).
 *
 * A classificação A/M/D/R do git é a fonte de verdade do *que* mudou; size/limit
 * e ignores são reaplicados aqui para manter simetria exata com o walk.
 */
export function gitDelta(
  rootPath: string,
  sinceRef: string,
  options: GitDeltaOptions = {},
): GitDeltaResult | null {
  if (!isGitRepository(rootPath) || !isValidGitRef(rootPath, sinceRef)) {
    return null;
  }

  const maxFileSize = options.max_file_size_bytes ?? DEFAULT_MAX_FILE_SIZE_BYTES;

  let raw: string;
  try {
    // `-z` separa registros/nomes por NUL — robusto a paths com espaços/quebras.
    // `--no-renames` simplifica: rename vira D + A.
    // `--relative -- .` é crucial quando o workspace é subdiretório do repo git
    // (monorepo): restringe o diff à subárvore do cwd e emite paths relativos ao
    // cwd, em vez de ao git toplevel. Sem isso, `join(rootPath, path)` aponta
    // para fora do workspace e arquivos do repo inteiro vazariam para o delta.
    raw = execFileSync(
      "git",
      ["diff", "--name-status", "--no-renames", "--relative", "-z", sinceRef, "--", "."],
      { cwd: rootPath, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
  } catch {
    return null;
  }

  const changed: DiscoveredFile[] = [];
  const removed: string[] = [];
  const limitations: DiscoveryLimitation[] = [];
  const changedSeen = new Set<string>();

  const addChanged = (relativePath: string): void => {
    if (shouldIgnore(relativePath) || changedSeen.has(relativePath)) {
      return;
    }
    const absolutePath = join(rootPath, relativePath);
    let stat: ReturnType<typeof lstatSync>;
    try {
      // `lstat` (não `stat`) para paridade com o walk: o walk filtra por
      // `Dirent.isFile()` (semântica lstat), então um symlink-para-arquivo NÃO é
      // indexado lá. Seguir o link aqui (`stat`) divergiria do walk.
      stat = lstatSync(absolutePath);
    } catch {
      // Path no diff mas não-stat-ável (ex.: removido depois do diff): trata
      // como removido para manter o índice consistente.
      removed.push(relativePath);
      return;
    }
    if (!stat.isFile()) {
      return;
    }
    if (stat.size > maxFileSize) {
      limitations.push({
        code: "MAX_FILE_SIZE",
        path: relativePath,
        message: `Arquivo omitido por limite de tamanho (${maxFileSize} bytes).`,
      });
      return;
    }
    changedSeen.add(relativePath);
    changed.push({
      relative_path: relativePath,
      absolute_path: absolutePath,
      size_bytes: stat.size,
      mtime_ms: stat.mtimeMs,
    });
  };

  // Formato `-z` sem renames: pares de tokens [status, path] separados por NUL.
  const tokens = raw.split("\0").filter((token) => token.length > 0);
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const code = tokens[i].charAt(0);
    const relativePath = normalizeRelativePath(tokens[i + 1]);
    if (shouldIgnore(relativePath)) {
      continue;
    }
    if (code === "D") {
      removed.push(relativePath);
      continue;
    }
    addChanged(relativePath);
  }

  // `git diff` não lista arquivos untracked; capturá-los explicitamente como
  // adicionados, senão um arquivo novo não commitado escaparia do delta.
  //
  // Crucial para a equivalência git-delta ≡ walk: NÃO usamos `--exclude-standard`
  // (que respeitaria `.gitignore`), porque o walk só ignora a lista fixa do
  // cortex (`shouldIgnore`), não o `.gitignore`. Em vez disso listamos todos os
  // untracked e aplicamos `shouldIgnore` — mesmo conjunto que o walk indexaria.
  // Pathspecs `:(exclude)` cortam os diretórios pesados conhecidos por
  // performance; `shouldIgnore` é o backstop de correção em qualquer profundidade.
  try {
    const excludeSpecs = DEFAULT_IGNORED_DIRECTORIES.flatMap((dir) => [
      `:(exclude)${dir}`,
      `:(exclude,glob)**/${dir}/**`,
    ]);
    const untracked = execFileSync(
      "git",
      ["ls-files", "--others", "-z", "--", ".", ...excludeSpecs],
      { cwd: rootPath, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    for (const rawPath of untracked.split("\0").filter((token) => token.length > 0)) {
      addChanged(normalizeRelativePath(rawPath));
    }
  } catch {
    /* sem untracked acessível: o diff já cobre o tracked */
  }

  changed.sort((a, b) => a.relative_path.localeCompare(b.relative_path));
  removed.sort((a, b) => a.localeCompare(b));
  return { changed, removed, limitations };
}
