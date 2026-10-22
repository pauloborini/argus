/**
 * Suporte a path aliases de tsconfig (paths e baseUrl) com extends de 1 nível.
 * Referência comportamental: codegraph MIT (src/resolution/path-aliases.ts e alias-binding.ts).
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export interface TsconfigAliasPattern {
  prefix: string;
  suffix: string;
  targets: string[];
  hasWildcard?: boolean;
}

export interface TsconfigAliasMap {
  baseUrl: string | null;
  patterns: TsconfigAliasPattern[];
}

/**
 * Remove comentários de linha (//), de bloco (/* *\/) e trailing commas de um JSONC.
 */
function stripJsonComments(text: string): string {
  let result = "";
  let inString = false;
  let inSingleComment = false;
  let inMultiComment = false;
  let escape = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    const nextChar = text[i + 1];

    if (inSingleComment) {
      if (char === "\n" || char === "\r") {
        inSingleComment = false;
        result += char;
      }
      continue;
    }

    if (inMultiComment) {
      if (char === "*" && nextChar === "/") {
        inMultiComment = false;
        i++;
      }
      continue;
    }

    if (inString) {
      result += char;
      if (escape) {
        escape = false;
      } else if (char === "\\") {
        escape = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      result += char;
      continue;
    }

    if (char === "/" && nextChar === "/") {
      inSingleComment = true;
      i++;
      continue;
    }

    if (char === "/" && nextChar === "*") {
      inMultiComment = true;
      i++;
      continue;
    }

    result += char;
  }

  return result.replace(/,\s*([}\]])/g, "$1");
}

function parseJsonc(content: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(stripJsonComments(content));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Localiza e carrega a configuração de aliases do tsconfig.json mais próximo do arquivo importador,
 * subindo na árvore de diretórios até o rootPath.
 *
 * Suporta extends a 1 nível (DEC2).
 */
export function loadTsconfigAliases(rootPath: string, fromDir: string): TsconfigAliasMap | null {
  const canonicalRoot = resolve(rootPath);
  let curr = isAbsolute(fromDir) ? resolve(fromDir) : resolve(canonicalRoot, fromDir);

  let foundTsconfigPath: string | null = null;

  while (true) {
    const candidate = join(curr, "tsconfig.json");
    if (existsSync(candidate)) {
      foundTsconfigPath = candidate;
      break;
    }

    if (curr === canonicalRoot) {
      break;
    }

    const parent = dirname(curr);
    if (parent === curr) {
      break;
    }

    const relToRoot = relative(canonicalRoot, parent).split("\\").join("/");
    if (relToRoot.startsWith("../") || relToRoot === "..") {
      break;
    }

    curr = parent;
  }

  if (!foundTsconfigPath) {
    return null;
  }

  let rawContent: string;
  try {
    rawContent = readFileSync(foundTsconfigPath, "utf-8");
  } catch {
    return null;
  }

  const json = parseJsonc(rawContent);
  if (!json) {
    return null;
  }

  const tsconfigDir = dirname(foundTsconfigPath);
  const compilerOptions = (json.compilerOptions ?? {}) as Record<string, unknown>;
  let rawPaths = (compilerOptions.paths ?? null) as Record<string, unknown> | null;
  let effectiveBaseUrl: string | null =
    typeof compilerOptions.baseUrl === "string"
      ? resolve(tsconfigDir, compilerOptions.baseUrl)
      : null;

  // Extends 1 nível (DEC2)
  if (typeof json.extends === "string") {
    let extendTarget = resolve(tsconfigDir, json.extends);
    if (!existsSync(extendTarget) && !extendTarget.endsWith(".json") && existsSync(`${extendTarget}.json`)) {
      extendTarget = `${extendTarget}.json`;
    }

    if (existsSync(extendTarget)) {
      try {
        const baseContent = readFileSync(extendTarget, "utf-8");
        const baseJson = parseJsonc(baseContent);
        if (baseJson) {
          const baseOptions = (baseJson.compilerOptions ?? {}) as Record<string, unknown>;
          if (baseOptions.paths && typeof baseOptions.paths === "object") {
            rawPaths = {
              ...(baseOptions.paths as Record<string, unknown>),
              ...(rawPaths ?? {}),
            };
          }
          if (effectiveBaseUrl === null) {
            if (typeof baseOptions.baseUrl === "string") {
              effectiveBaseUrl = resolve(dirname(extendTarget), baseOptions.baseUrl);
            } else if (baseOptions.paths) {
              effectiveBaseUrl = dirname(extendTarget);
            }
          }
        }
      } catch {
        // Degrada sem erro em base tsconfig ilegível
      }
    }
  }

  // Fallback da especificação do TypeScript (>= 4.1): paths sem baseUrl explícito
  // resolve relativo ao diretório do próprio tsconfig.json.
  if (effectiveBaseUrl === null) {
    effectiveBaseUrl = tsconfigDir;
  }

  if (!rawPaths || Object.keys(rawPaths).length === 0) {
    return null;
  }

  const patterns: TsconfigAliasPattern[] = [];
  for (const [key, val] of Object.entries(rawPaths)) {
    const targets = Array.isArray(val)
      ? val.filter((t): t is string => typeof t === "string")
      : typeof val === "string"
        ? [val]
        : [];

    if (targets.length === 0) {
      continue;
    }

    const starIndex = key.indexOf("*");
    if (starIndex !== -1) {
      patterns.push({
        prefix: key.slice(0, starIndex),
        suffix: key.slice(starIndex + 1),
        targets,
        hasWildcard: true,
      });
    } else {
      patterns.push({
        prefix: key,
        suffix: "",
        targets,
        hasWildcard: false,
      });
    }
  }

  if (patterns.length === 0) {
    return null;
  }

  return {
    baseUrl: effectiveBaseUrl,
    patterns,
  };
}
