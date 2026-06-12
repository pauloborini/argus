import { describe, expect, it } from "vitest";
import {
  FILE_MANIFEST_FILE,
  INDEX_DB_FILE,
  STRUCTURAL_INDEX_FILE,
  WORKSPACE_METADATA_FILE,
  getIndexDbPath,
  getManifestPath,
  getMetadataPath,
  getStructuralIndexPath,
} from "../src/workspace/workspace.js";

describe("workspace paths", () => {
  it("expõe caminhos canônicos para metadados e manifest S04", () => {
    expect(WORKSPACE_METADATA_FILE).toBe("workspace.json");
    expect(FILE_MANIFEST_FILE).toBe("file-manifest.json");
    expect(getMetadataPath("/tmp/repo")).toMatch(/\.cortex\/workspace\.json$/);
    expect(getManifestPath("/tmp/repo")).toMatch(/\.cortex\/file-manifest\.json$/);
    expect(STRUCTURAL_INDEX_FILE).toBe("structural-index.json");
    expect(getStructuralIndexPath("/tmp/repo")).toMatch(/\.cortex\/structural-index\.json$/);
    expect(INDEX_DB_FILE).toBe("index.db");
    expect(getIndexDbPath("/tmp/repo")).toMatch(/\.cortex\/index\.db$/);
  });
});
