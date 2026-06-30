import { basename, sep } from "node:path";

export const DEFAULT_IGNORED_DIRECTORIES = [
  "node_modules",
  ".pnpm-store",
  ".git",
  ".argus",
  "dist",
  "build",
  ".next",
  "coverage",
] as const;

export const DEFAULT_IGNORED_SUFFIXES = [".min.js", ".map"] as const;

export const DEFAULT_MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024;
export const DEFAULT_MAX_FILE_COUNT = 50_000;

const IGNORED_DIR_SET = new Set<string>(DEFAULT_IGNORED_DIRECTORIES);

export function normalizeRelativePath(relativePath: string): string {
  return relativePath.split(sep).join("/");
}

export function shouldIgnore(relativePath: string): boolean {
  if (!relativePath) {
    return false;
  }

  const normalized = normalizeRelativePath(relativePath);
  const segments = normalized.split("/").filter(Boolean);
  const base = basename(normalized);

  if (segments.some((segment) => IGNORED_DIR_SET.has(segment))) {
    return true;
  }

  return DEFAULT_IGNORED_SUFFIXES.some((suffix) => base.endsWith(suffix));
}
