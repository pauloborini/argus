/**
 * Builder compartilhado de snippets acionáveis (Plano 3).
 * Lê bytes reais do arquivo e aplica caps determinísticos por style.
 * Explore e pack_context reutilizam este owner — sem mock no seam S3.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { countTokens } from "../../packing/tokenizer.js";
import type { ExploreSnippetRef } from "./common.js";

export type SnippetStyle = "brief" | "balanced" | "deep";

export type SnippetBodyMode = "none" | "window" | "full";

export interface SnippetStyleCaps {
  bodyMode: SnippetBodyMode;
  /** Máximo de linhas do corpo (além da assinatura) em mode window/full. */
  maxBodyLines: number;
  /** Máximo de tokens do corpo verbatim em mode window. */
  maxBodyTokens: number;
  snippetLimit: number;
  depth: number;
  budget: number;
}

/** Caps determinísticos por style — budget por segmento antes da compressão. */
export const SNIPPET_STYLE_CAPS: Record<SnippetStyle, SnippetStyleCaps> = {
  brief: {
    bodyMode: "none",
    maxBodyLines: 0,
    maxBodyTokens: 0,
    snippetLimit: 1,
    depth: 1,
    budget: 4,
  },
  balanced: {
    bodyMode: "window",
    maxBodyLines: 16,
    maxBodyTokens: 120,
    snippetLimit: 2,
    depth: 2,
    budget: 6,
  },
  deep: {
    bodyMode: "full",
    maxBodyLines: 400,
    maxBodyTokens: 4000,
    snippetLimit: 3,
    depth: 4,
    budget: 10,
  },
};

export function getSnippetStyleCaps(style: SnippetStyle = "balanced"): SnippetStyleCaps {
  return SNIPPET_STYLE_CAPS[style];
}

/**
 * Lê só a assinatura do símbolo: da linha de declaração até o abre-corpo
 * (`{` ou `:` final) ou um teto de 3 linhas. Whitespace colapsado, cap ~200 chars.
 */
export function readSymbolSignature(
  cwd: string,
  path: string,
  startLine: number,
  endLine: number,
): string | null {
  try {
    const absolutePath = join(cwd, path);
    const lines = readFileSync(absolutePath, "utf-8").split("\n");
    const start = Math.max(0, startLine - 1);
    const hardEnd = Math.min(lines.length, endLine);
    const collected: string[] = [];
    for (let i = start; i < hardEnd && collected.length < 3; i += 1) {
      const line = lines[i] ?? "";
      collected.push(line);
      if (line.includes("{") || line.trimEnd().endsWith(":")) {
        break;
      }
    }
    const declaration = collected.join(" ");
    let bodyStart = declaration.length;
    const pythonDeclaration = /^\s*(?:async\s+)?(?:def|class)\b/.test(declaration);
    let nesting = 0;
    for (let i = 0; i < declaration.length; i += 1) {
      const char = declaration[i];
      if (char === "(" || char === "[" || char === "<") {
        nesting += 1;
      } else if (char === ")" || char === "]" || char === ">") {
        nesting = Math.max(0, nesting - 1);
      } else if (char === "{") {
        bodyStart = i;
        break;
      } else if (char === "=" && declaration[i + 1] === ">") {
        bodyStart = i;
        break;
      } else if (char === ":" && nesting === 0 && pythonDeclaration) {
        bodyStart = i + 1;
        break;
      }
    }
    const signature = declaration
      .slice(0, bodyStart)
      .replace(/\s+/g, " ")
      .trim();
    if (!signature) {
      return null;
    }
    return signature.length > 200 ? `${signature.slice(0, 197)}...` : signature;
  } catch {
    return null;
  }
}

export interface SymbolBodyWindow {
  /** Trecho verbatim do arquivo (linhas do símbolo, possivelmente truncadas). */
  body: string;
  /** true quando o corpo do símbolo foi cortado pelos caps. */
  truncated: boolean;
  start_line: number;
  end_line: number;
}

/**
 * Lê o corpo completo do símbolo sem caps de style — usado para persistir
 * retrieve_handle reversível quando o snippet balanced/deep truncou.
 */
export function readFullSymbolBody(
  cwd: string,
  path: string,
  startLine: number,
  endLine: number,
): string | null {
  try {
    const absolutePath = join(cwd, path);
    const lines = readFileSync(absolutePath, "utf-8").split("\n");
    const start = Math.max(0, startLine - 1);
    const end = Math.min(lines.length, endLine);
    const body = lines.slice(start, end).join("\n").trim();
    return body.length > 0 ? body : null;
  } catch {
    return null;
  }
}

/**
 * Janela verbatim ao redor do símbolo com caps por style.
 * Retorna null se ilegível/vazio ou se bodyMode === "none".
 */
export function readSymbolBodyWindow(
  cwd: string,
  path: string,
  startLine: number,
  endLine: number,
  caps: SnippetStyleCaps,
): SymbolBodyWindow | null {
  if (caps.bodyMode === "none") {
    return null;
  }
  try {
    const absolutePath = join(cwd, path);
    const lines = readFileSync(absolutePath, "utf-8").split("\n");
    const start = Math.max(0, startLine - 1);
    const symbolEnd = Math.min(lines.length, endLine);
    const fullSlice = lines.slice(start, symbolEnd);
    if (fullSlice.length === 0) {
      return null;
    }

    let kept = fullSlice;
    let truncated = false;

    if (caps.bodyMode === "window" || caps.bodyMode === "full") {
      if (kept.length > caps.maxBodyLines) {
        kept = kept.slice(0, caps.maxBodyLines);
        truncated = true;
      }
      while (kept.length > 1 && countTokens(kept.join("\n")) > caps.maxBodyTokens) {
        kept = kept.slice(0, -1);
        truncated = true;
      }
    }

    const body = kept.join("\n").trim();
    if (!body) {
      return null;
    }
    if (!truncated && (symbolEnd - start > kept.length || fullSlice.join("\n").trim() !== body)) {
      truncated = true;
    }

    return {
      body,
      truncated,
      start_line: startLine,
      end_line: startLine + kept.length - 1,
    };
  } catch {
    return null;
  }
}

export interface BuiltSnippet extends ExploreSnippetRef {
  body?: string;
  truncated?: boolean;
}

/**
 * Monta um ExploreSnippetRef acionável: signature sempre; body conforme style.
 */
export function buildActionableSnippet(
  cwd: string,
  path: string,
  startLine: number,
  endLine: number,
  symbol: string | undefined,
  style: SnippetStyle = "balanced",
): BuiltSnippet {
  const caps = getSnippetStyleCaps(style);
  const signature = readSymbolSignature(cwd, path, startLine, endLine) ?? undefined;
  const window = readSymbolBodyWindow(cwd, path, startLine, endLine, caps);
  return {
    path,
    start_line: startLine,
    end_line: endLine,
    symbol,
    signature,
    ...(window
      ? {
          body: window.body,
          truncated: window.truncated,
        }
      : {}),
  };
}

/**
 * Formata bloco de texto para pack_context a partir do snippet construído.
 * Brief: handle + signature. Balanced/deep: `Snippet path:lines` + corpo.
 */
export function formatSnippetBlock(snippet: BuiltSnippet, style: SnippetStyle = "balanced"): string {
  const caps = getSnippetStyleCaps(style);
  const head = `Símbolo ${snippet.symbol ?? snippet.path}@${snippet.path}:${snippet.start_line}-${snippet.end_line}`;

  if (caps.bodyMode === "none") {
    return snippet.signature ? `${head} — ${snippet.signature}` : head;
  }

  if (snippet.body) {
    return `Snippet ${snippet.path}:${snippet.start_line}-${snippet.end_line}\n${snippet.body}`;
  }

  return snippet.signature ? `${head} — ${snippet.signature}` : head;
}
