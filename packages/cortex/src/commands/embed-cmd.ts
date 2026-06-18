import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildChunkText } from "../embeddings/chunk-text.js";
import { createEmbedder, EmbeddingsUnavailableError, type Embedder } from "../embeddings/embedder.js";
import { quantizeInt8 } from "../embeddings/quantize.js";
import {
  replaceEmbeddings,
  readSymbolsForEmbedding,
  type EmbeddingInsert,
} from "../storage/embeddings-store.js";
import {
  closeIndexDb,
  isIndexDbPopulated,
  openIndexDb,
  readIndexMeta,
} from "../storage/sqlite-index-store.js";
import { getIndexDbPath, requireWorkspace } from "../workspace/workspace.js";

export interface EmbedOptions {
  /** Tamanho do lote de inferência (default 32). */
  batch?: number;
  /** Injeção de embedder para teste; default = adapter real (transformers.js). */
  embedder?: Embedder;
}

/**
 * Gera embeddings densos do índice estrutural já existente. Off-by-default:
 * roda só quando o usuário invoca `cortex embed` (nem `index` nem o daemon
 * embeddam sozinhos), então os vetores podem ficar stale — `semantic_search`
 * sinaliza isso. O modelo real baixa no 1º uso (cache do transformers.js).
 */
export async function runEmbed(options: EmbedOptions = {}): Promise<number> {
  let rootPath: string;
  try {
    rootPath = requireWorkspace().root_path;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  const dbPath = getIndexDbPath(rootPath);
  if (!existsSync(dbPath)) {
    console.error("E_INDEX_MISSING: Índice ausente; execute cortex index antes de cortex embed.");
    return 1;
  }

  const db = openIndexDb(dbPath);
  try {
    if (!isIndexDbPopulated(db)) {
      console.error("E_INDEX_MISSING: Índice vazio; execute cortex index antes de cortex embed.");
      return 1;
    }

    const meta = readIndexMeta(db);
    const symbols = readSymbolsForEmbedding(db);
    if (symbols.length === 0) {
      console.error("Nenhum símbolo indexado para embeddar.");
      return 1;
    }

    // Lê cada arquivo uma vez; símbolos do mesmo path compartilham as linhas.
    const linesCache = new Map<string, string[]>();
    const readLines = (relativePath: string): string[] => {
      const cached = linesCache.get(relativePath);
      if (cached) {
        return cached;
      }
      let lines: string[] = [];
      try {
        lines = readFileSync(join(rootPath, relativePath), "utf-8").split("\n");
      } catch {
        lines = [];
      }
      linesCache.set(relativePath, lines);
      return lines;
    };

    const texts = symbols.map((symbol) =>
      buildChunkText(symbol.relative_path, symbol, readLines(symbol.relative_path)),
    );

    const embedder = options.embedder ?? createEmbedder();
    const batchSize = options.batch && options.batch > 0 ? options.batch : 32;
    const inserts: EmbeddingInsert[] = [];

    try {
      for (let offset = 0; offset < texts.length; offset += batchSize) {
        const batchTexts = texts.slice(offset, offset + batchSize);
        const vectors = await embedder.embed(batchTexts);
        for (let i = 0; i < vectors.length; i += 1) {
          const { bytes, scale } = quantizeInt8(vectors[i]);
          inserts.push({
            symbol_id: symbols[offset + i].symbol_id,
            bytes,
            scale,
            content_hash: createHash("sha1").update(batchTexts[i]).digest("hex").slice(0, 16),
          });
        }
        process.stdout.write(
          `\rEmbeddando ${Math.min(offset + batchSize, texts.length)}/${texts.length} símbolos…`,
        );
      }
      process.stdout.write("\n");
    } catch (err) {
      if (err instanceof EmbeddingsUnavailableError) {
        console.error(err.message);
        return 1;
      }
      throw err;
    }

    replaceEmbeddings(
      db,
      {
        model: embedder.model,
        dim: embedder.dim,
        built_at: new Date().toISOString(),
        symbol_count: inserts.length,
        manifest_hash: meta?.manifest_hash ?? "",
      },
      inserts,
    );

    console.log(
      `Embeddings gerados: ${inserts.length} símbolos (modelo ${embedder.model}, dim ${embedder.dim}).`,
    );
    return 0;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  } finally {
    closeIndexDb(db);
  }
}
