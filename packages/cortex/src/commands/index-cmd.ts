import { buildDiscoveryManifest, fingerprintDiscoveredFiles } from "../discovery/fingerprint.js";
import { writeManifestAtomic } from "../discovery/manifest.js";
import { discoverFiles } from "../discovery/walk.js";
import { buildStructuralIndex } from "../extraction/pipeline.js";
import { persistFullStructuralIndex } from "../storage/index-persistence.js";
import { getManifestPath, requireWorkspace } from "../workspace/workspace.js";

export async function runIndex(): Promise<number> {
  let rootPath: string;
  try {
    const metadata = requireWorkspace();
    rootPath = metadata.root_path;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(message);
    return 1;
  }

  try {
    const discovery = discoverFiles(rootPath);
    const fingerprints = fingerprintDiscoveredFiles(discovery.files);
    const manifest = buildDiscoveryManifest(rootPath, fingerprints);
    const { index, summary } = await buildStructuralIndex(manifest, rootPath);

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
