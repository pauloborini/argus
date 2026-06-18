import { existsSync } from "node:fs";
import { join } from "node:path";
import { closeIndexDb, isIndexDbPopulated, openIndexDb } from "../storage/sqlite-index-store.js";
import { getIndexDbPath, requireWorkspace } from "../workspace/workspace.js";

export interface ScipImportOptions {
  path?: string;
}

/**
 * Importa edges SCIP de um index.scip para o índice estrutural.
 * Off-by-default: roda apenas via `cortex scip import`, não auto-sincroniza.
 */
export async function runScipImport(options: ScipImportOptions = {}): Promise<number> {
  let rootPath: string;
  try {
    rootPath = requireWorkspace().root_path;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  const dbPath = getIndexDbPath(rootPath);
  if (!existsSync(dbPath)) {
    console.error("E_INDEX_MISSING: Índice ausente; execute cortex index antes de cortex scip import.");
    return 1;
  }

  const scipPath = options.path ?? join(rootPath, "index.scip");
  if (!existsSync(scipPath)) {
    console.error(`E_SCIP_NOT_FOUND: Arquivo SCIP não encontrado em ${scipPath}.`);
    console.error("Dica: gere index.scip com scip-typescript/scip-python no CI do projeto.");
    return 1;
  }

  let parseScipFile: typeof import("../scip/parse-scip.js").parseScipFile;
  let importScipEdges: typeof import("../scip/scip-to-edges.js").importScipEdges;

  try {
    const parserMod = await import("../scip/parse-scip.js");
    parseScipFile = parserMod.parseScipFile;
  } catch (err) {
    if (err && (err as { name?: string }).name === "ScipUnavailableError") {
      console.error((err as Error).message);
    } else {
      const detail = err instanceof Error ? err.message : String(err);
      console.error(`W_SCIP_UNAVAILABLE: Falha ao carregar parser SCIP (${detail}).`);
    }
    return 1;
  }

  try {
    const edgesMod = await import("../scip/scip-to-edges.js");
    importScipEdges = edgesMod.importScipEdges;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`W_SCIP_UNAVAILABLE: Falha ao carregar módulo de importação (${detail}).`);
    return 1;
  }

  const db = openIndexDb(dbPath);
  try {
    if (!isIndexDbPopulated(db)) {
      console.error("E_INDEX_MISSING: Índice vazio; execute cortex index antes de cortex scip import.");
      return 1;
    }

    console.log(`Decodificando ${scipPath}…`);
    const scipIndex = await parseScipFile(scipPath);
    console.log(`SCIP: ${scipIndex.documents.length} documentos encontrados.`);

    const result = importScipEdges(db, scipIndex);

    console.log(`Importação SCIP concluída:`);
    console.log(`  Edges importadas: ${result.edgesImported}`);
    console.log(`  Arquivos casados: ${result.filesMatched}`);
    console.log(`  Arquivos sem correspondência: ${result.filesMissing}`);
    console.log(`  Símbolos cobertos: ${result.symbolsCovered}`);

    if (result.filesMatched === 0 && result.filesMissing > 0) {
      console.log("\nAviso: nenhum arquivo SCIP casou com o índice. Verifique se os paths relativos são compatíveis.");
    }

    return 0;
  } catch (err) {
    if (err && (err as { name?: string }).name === "ScipUnavailableError") {
      console.error((err as Error).message);
      return 1;
    }
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  } finally {
    closeIndexDb(db);
  }
}
