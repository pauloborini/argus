// Texto de entrada do embedding por símbolo. Reusa o chunking AST que já
// existe (1 símbolo = 1 chunk com range de linhas conhecido), evitando o pior
// pitfall de chunking cego por janela fixa. Prefixa path/nome/kind para dar
// sinal estrutural ao modelo, depois o corpo real, truncado a um teto de chars
// (bge-small satura ~512 tokens; ~2000 chars cobre a maioria dos símbolos sem
// estourar e mantém o embed barato).

export const MAX_CHUNK_CHARS = 2000;

export interface ChunkSymbol {
  name: string;
  kind: string;
  start_line: number;
  end_line: number;
}

/**
 * Monta o texto a embeddar para um símbolo. `sourceLines` são as linhas do
 * arquivo (1-based via start_line/end_line). Faltando o corpo (linhas fora de
 * range), cai para só o cabeçalho estrutural — ainda embeddável.
 */
export function buildChunkText(
  relativePath: string,
  symbol: ChunkSymbol,
  sourceLines: string[],
): string {
  const header = `${relativePath} ${symbol.name} ${symbol.kind}`;
  const from = Math.max(0, symbol.start_line - 1);
  const to = Math.min(sourceLines.length, symbol.end_line);
  const body = from < to ? sourceLines.slice(from, to).join("\n") : "";
  const text = body ? `${header}\n${body}` : header;
  return text.length > MAX_CHUNK_CHARS ? text.slice(0, MAX_CHUNK_CHARS) : text;
}
