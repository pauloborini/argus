import { describe, expect, it } from "vitest";
import {
  FILE_MANIFEST_FILE,
  WORKSPACE_METADATA_FILE,
  getManifestPath,
  getMetadataPath,
} from "../src/workspace/workspace.js";

describe("workspace paths", () => {
  it("expõe caminhos canônicos para metadados e manifest S04", () => {
    expect(WORKSPACE_METADATA_FILE).toBe("workspace.json");
    expect(FILE_MANIFEST_FILE).toBe("file-manifest.json");
    expect(getMetadataPath("/tmp/repo")).toMatch(/\.cortex\/workspace\.json$/);
    expect(getManifestPath("/tmp/repo")).toMatch(/\.cortex\/file-manifest\.json$/);
  });
});
