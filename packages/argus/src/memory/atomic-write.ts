import { renameSync, rmSync, statSync, writeFileSync } from "node:fs";

/**
 * Escreve um arquivo de forma atômica utilizando o padrão tmp + rename.
 *
 * 1. tmp = `${filePath}.${process.pid}.${Date.now()}.tmp` (mesmo diretório do alvo — rename é atômico)
 * 2. mode = statSync(filePath).mode se o arquivo existir (preserva permissões), senão default
 * 3. writeFileSync(tmp, data, { encoding: "utf-8", ...(mode !== undefined ? { mode } : {}) })
 * 4. renameSync(tmp, filePath)
 * 5. em qualquer erro após criar o tmp: rmSync(tmp, { force: true }) e relançar
 */
export function writeFileAtomic(filePath: string, data: string): void {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  let mode: number | undefined;
  try {
    mode = statSync(filePath).mode;
  } catch {
    // Arquivo alvo ainda não existe — usa permissões default do sistema/umask
  }

  try {
    writeFileSync(tempPath, data, {
      encoding: "utf-8",
      ...(mode !== undefined ? { mode } : {}),
    });
    renameSync(tempPath, filePath);
  } catch (error) {
    try {
      rmSync(tempPath, { force: true });
    } catch {
      // Ignora erro de limpeza para relançar o erro original
    }
    throw error;
  }
}
