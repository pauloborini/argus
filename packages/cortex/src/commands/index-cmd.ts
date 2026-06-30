import { buildDiscoveryManifest, fingerprintDiscoveredFiles } from "../discovery/fingerprint.js";
import { writeManifestAtomic } from "../discovery/manifest.js";
import { discoverFiles } from "../discovery/walk.js";
import { buildStructuralIndex } from "../extraction/pipeline.js";
import { persistFullStructuralIndex } from "../storage/index-persistence.js";
import {
  getManifestPath,
  requireWorkspace,
  resolveRespectGitignore,
} from "../workspace/workspace.js";

export interface IndexOptions {
  /** Override por execução do respeito a `.gitignore` (workspace é o default). */
  respectGitignore?: boolean;
}

export async function runIndex(options: IndexOptions = {}): Promise<number> {
  let rootPath: string;
  let respectGitignore: boolean;
  try {
    const metadata = requireWorkspace();
    rootPath = metadata.root_path;
    respectGitignore = resolveRespectGitignore(metadata, options.respectGitignore);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(message);
    return 1;
  }

  try {
    console.log("Inventariando arquivos...");
    const discovery = discoverFiles(rootPath, { respect_gitignore: respectGitignore });
    console.log(`  ${discovery.files.length} arquivos encontrados.`);

    console.log("Calculando fingerprints...");
    const fingerprints = fingerprintDiscoveredFiles(discovery.files);
    const manifest = buildDiscoveryManifest(rootPath, fingerprints);

    console.log(`Extraindo estrutura (${manifest.file_count} arquivos)...`);
    const { index, summary } = await buildStructuralIndex(manifest, rootPath);

    console.log("Salvando índice...");
    writeManifestAtomic(getManifestPath(rootPath), manifest);
    persistFullStructuralIndex(rootPath, index);

    console.log(`Index concluído: ${manifest.file_count} arquivos inventariados.`);
    console.log(
      `Extração estrutural: ${summary.files_parsed} arquivos, ${summary.symbol_count} símbolos (${summary.duration_ms}ms).`,
    );

    if (discovery.limitations.length > 0) {
      console.warn("Index parcial: limites de discovery atingidos.");
      for (const limitation of discovery.limitations) {
        console.warn(`- ${limitation.code}: ${limitation.path ?? "-"} ${limitation.message}`);
      }
    }

    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`E_WORKSPACE_INVALID: Falha durante indexação: ${message}`);
    return 1;
  }
}
