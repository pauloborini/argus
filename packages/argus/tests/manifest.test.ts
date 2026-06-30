import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildDiscoveryManifest,
  fingerprintDiscoveredFiles,
  hashFile,
} from "../src/discovery/fingerprint.js";
import {
  ManifestCorruptedError,
  readManifest,
  writeManifestAtomic,
} from "../src/discovery/manifest.js";
import type { DiscoveredFile } from "../src/discovery/types.js";

describe("manifest e fingerprint", () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it("gera hash estável para mesmo conteúdo", () => {
    tempDir = mkdtempSync(join(tmpdir(), "argus-manifest-"));
    const filePath = join(tempDir, "sample.ts");
    writeFileSync(filePath, "export const x = 1;\n", "utf-8");

    const first = hashFile(filePath);
    const second = hashFile(filePath);
    expect(first).toBe(second);
    expect(first).toHaveLength(64);
  });

  it("persiste e lê manifest via escrita atômica", () => {
    tempDir = mkdtempSync(join(tmpdir(), "argus-manifest-"));
    const filePath = join(tempDir, "sample.ts");
    writeFileSync(filePath, "export const y = 2;\n", "utf-8");

    const files: DiscoveredFile[] = [
      {
        relative_path: "sample.ts",
        absolute_path: filePath,
        size_bytes: 20,
        mtime_ms: Date.now(),
      },
    ];
    const fingerprints = fingerprintDiscoveredFiles(files);
    const manifest = buildDiscoveryManifest(tempDir, fingerprints);
    const manifestPath = join(tempDir, ".argus", "file-manifest.json");

    writeManifestAtomic(manifestPath, manifest);
    const loaded = readManifest(manifestPath);

    expect(loaded).not.toBeNull();
    expect(loaded?.file_count).toBe(1);
    expect(loaded?.files[0]?.relative_path).toBe("sample.ts");
  });

  it("falha ao ler manifest corrompido com files inválido", () => {
    tempDir = mkdtempSync(join(tmpdir(), "argus-manifest-"));
    const manifestPath = join(tempDir, ".argus", "file-manifest.json");
    mkdirSync(join(tempDir, ".argus"), { recursive: true });
    writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          schema_version: "v1",
          generated_at: new Date().toISOString(),
          root_path: tempDir,
          file_count: 1,
          files: [{ relative_path: "sample.ts", content_hash: 123, size_bytes: "20", mtime_ms: [] }],
        },
        null,
        2,
      ) + "\n",
      "utf-8",
    );

    expect(() => readManifest(manifestPath)).toThrow(ManifestCorruptedError);
  });
});
