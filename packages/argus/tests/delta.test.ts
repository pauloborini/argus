import { describe, expect, it } from "vitest";
import { planManifestSync } from "../src/discovery/delta.js";
import type { DiscoveredFile, DiscoveryManifest } from "../src/discovery/types.js";

describe("manifest sync planning", () => {
  it("reaproveita fingerprints inalterados e seleciona só delta para rehash", () => {
    const previousManifest: DiscoveryManifest = {
      schema_version: "1.0.0",
      generated_at: new Date().toISOString(),
      root_path: "/tmp/workspace",
      file_count: 2,
      files: [
        {
          relative_path: "a.ts",
          content_hash: "hash-a",
          size_bytes: 10,
          mtime_ms: 100,
        },
        {
          relative_path: "b.ts",
          content_hash: "hash-b",
          size_bytes: 20,
          mtime_ms: 200,
        },
      ],
    };

    const discoveredFiles: DiscoveredFile[] = [
      {
        relative_path: "a.ts",
        absolute_path: "/tmp/workspace/a.ts",
        size_bytes: 10,
        mtime_ms: 100,
      },
      {
        relative_path: "b.ts",
        absolute_path: "/tmp/workspace/b.ts",
        size_bytes: 25,
        mtime_ms: 250,
      },
      {
        relative_path: "c.ts",
        absolute_path: "/tmp/workspace/c.ts",
        size_bytes: 30,
        mtime_ms: 300,
      },
    ];

    const plan = planManifestSync(previousManifest, discoveredFiles);

    expect(plan.preserved.map((file) => file.relative_path)).toEqual(["a.ts"]);
    expect(plan.changed.map((file) => file.relative_path)).toEqual(["b.ts"]);
    expect(plan.added.map((file) => file.relative_path)).toEqual(["c.ts"]);
    expect(plan.removed).toEqual([]);
    expect(plan.unchanged_count).toBe(1);
    expect(plan.pending_files_count).toBe(2);
  });
});
