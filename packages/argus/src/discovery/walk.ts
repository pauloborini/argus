import { readdirSync, statSync } from "node:fs";
import type { Dirent } from "node:fs";
import { join } from "node:path";
import type { DiscoveredFile } from "./types.js";
import {
  DEFAULT_MAX_FILE_COUNT,
  DEFAULT_MAX_FILE_SIZE_BYTES,
  normalizeRelativePath,
  shouldIgnore,
} from "./ignores.js";
import { buildIgnoreContext } from "./gitignore.js";

export interface DiscoveryLimitation {
  code: "MAX_FILE_SIZE" | "MAX_FILE_COUNT" | "READ_ERROR";
  message: string;
  path?: string;
}

export interface DiscoverFilesResult {
  files: DiscoveredFile[];
  limitations: DiscoveryLimitation[];
}

export interface DiscoverFilesOptions {
  max_file_size_bytes?: number;
  max_file_count?: number;
  /** Default `true`: não indexa arquivos cobertos por `.gitignore`. */
  respect_gitignore?: boolean;
}

/** Contador de walks completos de discovery (S7 / sync delta). */
let discoverWalkCount = 0;

export function getDiscoverWalkCount(): number {
  return discoverWalkCount;
}

export function resetDiscoverWalkCount(): void {
  discoverWalkCount = 0;
}

export function discoverFiles(
  rootPath: string,
  options: DiscoverFilesOptions = {},
): DiscoverFilesResult {
  discoverWalkCount += 1;
  const maxFileSize = options.max_file_size_bytes ?? DEFAULT_MAX_FILE_SIZE_BYTES;
  const maxFileCount = options.max_file_count ?? DEFAULT_MAX_FILE_COUNT;
  const ignoreContext = buildIgnoreContext(rootPath, {
    respect_gitignore: options.respect_gitignore,
  });
  const files: DiscoveredFile[] = [];
  const limitations: DiscoveryLimitation[] = [];
  const queue: string[] = [""];
  let hitMaxFileCount = false;

  while (queue.length > 0 && !hitMaxFileCount) {
    const currentRelative = queue.shift() ?? "";
    const currentAbsolute = currentRelative ? join(rootPath, currentRelative) : rootPath;

    let entries: Dirent[];
    try {
      entries = readdirSync(currentAbsolute, { withFileTypes: true });
    } catch {
      limitations.push({
        code: "READ_ERROR",
        path: normalizeRelativePath(currentRelative || "."),
        message: "Falha ao listar diretório durante discovery.",
      });
      continue;
    }

    for (const entry of entries) {
      const childRelative = normalizeRelativePath(
        currentRelative ? join(currentRelative, entry.name) : entry.name,
      );
      if (shouldIgnore(childRelative)) {
        continue;
      }

      const childAbsolute = join(rootPath, childRelative);

      if (entry.isDirectory()) {
        if (ignoreContext.isIgnoredDir(childRelative)) {
          continue;
        }
        queue.push(childRelative);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      if (ignoreContext.isIgnoredFile(childRelative)) {
        continue;
      }

      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(childAbsolute);
      } catch {
        limitations.push({
          code: "READ_ERROR",
          path: childRelative,
          message: "Falha ao ler metadados do arquivo durante discovery.",
        });
        continue;
      }

      if (stat.size > maxFileSize) {
        limitations.push({
          code: "MAX_FILE_SIZE",
          path: childRelative,
          message: `Arquivo omitido por limite de tamanho (${maxFileSize} bytes).`,
        });
        continue;
      }

      if (files.length >= maxFileCount) {
        limitations.push({
          code: "MAX_FILE_COUNT",
          message: `Limite de arquivos atingido (${maxFileCount}). Discovery parcial.`,
        });
        hitMaxFileCount = true;
        break;
      }

      files.push({
        relative_path: childRelative,
        absolute_path: childAbsolute,
        size_bytes: stat.size,
        mtime_ms: stat.mtimeMs,
      });
    }
  }

  files.sort((a, b) => a.relative_path.localeCompare(b.relative_path));
  return { files, limitations };
}
