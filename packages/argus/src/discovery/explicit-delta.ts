import { lstatSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { buildIgnoreContext } from "./gitignore.js";
import { normalizeRelativePath } from "./ignores.js";
import type { DiscoveredFile } from "./types.js";

export interface ExplicitDeltaResult {
  /** Arquivos existentes (criados ou modificados) a re-fingerprintar. */
  changed: DiscoveredFile[];
  /** Paths relativos removidos do disco. */
  removed: string[];
}

export interface ExplicitDeltaOptions {
  respect_gitignore?: boolean;
  max_file_size_bytes?: number;
}

const DEFAULT_MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024;

/**
 * Constrói o delta de sync a partir de uma lista explícita de paths alterados
 * (tipicamente vinda de um watcher de filesystem), sem walk completo nem
 * git-delta. Para cada path: se existe como arquivo e não é ignorado pelo
 * `.gitignore`, vira `changed`; se sumiu do disco, vira `removed`. Diretórios,
 * symlinks e arquivos acima do limite de tamanho são descartados (paridade com
 * o walk via `lstat` + filtro de tamanho).
 *
 * Os paths de entrada podem ser absolutos ou relativos ao `rootPath`; a saída
 * usa sempre paths relativos normalizados (`/`), iguais aos do manifest.
 */
export function buildExplicitDelta(
  rootPath: string,
  paths: string[],
  options: ExplicitDeltaOptions = {},
): ExplicitDeltaResult {
  const respectGitignore = options.respect_gitignore ?? true;
  const maxFileSize = options.max_file_size_bytes ?? DEFAULT_MAX_FILE_SIZE_BYTES;
  const ignoreContext = buildIgnoreContext(rootPath, { respect_gitignore: respectGitignore });

  const changedByPath = new Map<string, DiscoveredFile>();
  const removed = new Set<string>();
  const root = resolve(rootPath);

  for (const raw of paths) {
    if (!raw) {
      continue;
    }
    const absolute = isAbsolute(raw) ? resolve(raw) : resolve(root, raw);
    const rel = normalizeRelativePath(relative(root, absolute));
    // Fora da subárvore do workspace: ignora (não escapa o root).
    if (!rel || rel.startsWith("../")) {
      continue;
    }
    if (respectGitignore && ignoreContext.isIgnoredFile(rel)) {
      continue;
    }

    let stat;
    try {
      stat = lstatSync(absolute);
    } catch {
      // Sumiu do disco → remoção. Diretórios removidos não chegam aqui como
      // arquivo individual; o watcher emite os arquivos filhos.
      removed.add(rel);
      continue;
    }

    // `lstat` para paridade com `Dirent.isFile()` do walk: symlink não conta
    // como arquivo regular.
    if (!stat.isFile() || stat.size > maxFileSize) {
      continue;
    }

    changedByPath.set(rel, {
      relative_path: rel,
      absolute_path: absolute,
      size_bytes: stat.size,
      mtime_ms: stat.mtimeMs,
    });
  }

  // Um path não pode ser changed e removed ao mesmo tempo; changed vence
  // (o último evento observado disse que existe).
  for (const rel of changedByPath.keys()) {
    removed.delete(rel);
  }

  return {
    changed: [...changedByPath.values()],
    removed: [...removed],
  };
}
