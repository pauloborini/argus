import { buildDiscoveryManifest, fingerprintDiscoveredFiles } from "../discovery/fingerprint.js";
import { writeManifestAtomic } from "../discovery/manifest.js";
import { discoverFiles } from "../discovery/walk.js";
import { getManifestPath, requireWorkspace } from "../workspace/workspace.js";

export function runIndex(): number {
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
    writeManifestAtomic(getManifestPath(rootPath), manifest);

    console.log(`Index concluído: ${manifest.file_count} arquivos inventariados.`);
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
