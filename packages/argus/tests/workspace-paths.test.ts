import { describe, expect, it } from "vitest";
import {
  FILE_MANIFEST_FILE,
  INDEX_DB_FILE,
  STRUCTURAL_INDEX_FILE,
  WORKSPACE_METADATA_FILE,
  getIndexDbPath,
  getManifestPath,
  getMetadataPath,
  getStatePaths,
  getStructuralIndexPath,
} from "../src/workspace/workspace.js";

describe("workspace paths", () => {
  it("expõe caminhos canônicos para metadados e manifest S04", () => {
    expect(WORKSPACE_METADATA_FILE).toBe("workspace.json");
    expect(FILE_MANIFEST_FILE).toBe("file-manifest.json");
    expect(getMetadataPath("/tmp/repo")).toMatch(/\.argus\/workspace\.json$/);
    expect(getManifestPath("/tmp/repo")).toMatch(/\.argus\/file-manifest\.json$/);
    expect(STRUCTURAL_INDEX_FILE).toBe("structural-index.json");
    expect(getStructuralIndexPath("/tmp/repo")).toMatch(/\.argus\/structural-index\.json$/);
    expect(INDEX_DB_FILE).toBe("index.db");
    expect(getIndexDbPath("/tmp/repo")).toMatch(/\.argus\/index\.db$/);
  });

  it("getStatePaths centraliza artefatos sob um único .argus", () => {
    const paths = getStatePaths("/tmp/repo");
    expect(paths.stateDir).toBe("/tmp/repo/.argus");
    expect(paths.manifest).toBe("/tmp/repo/.argus/file-manifest.json");
    expect(paths.indexDb).toBe("/tmp/repo/.argus/index.db");
    expect(paths.dirtyFlag).toBe("/tmp/repo/.argus/dirty.json");
    expect(paths.syncLock).toBe("/tmp/repo/.argus/sync.lock");
    expect(paths.memoryDb).toBe("/tmp/repo/.argus/memory/memory.db");
    expect(paths.packedHandlesDir).toBe("/tmp/repo/.argus/packed-handles");
  });
});
