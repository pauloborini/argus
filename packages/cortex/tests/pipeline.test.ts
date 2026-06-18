import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildDiscoveryManifest, fingerprintDiscoveredFiles } from "../src/discovery/fingerprint.js";
import { discoverFiles } from "../src/discovery/walk.js";
import { buildStructuralIndex, updateStructuralIndexDelta } from "../src/extraction/pipeline.js";

describe("pipeline de extração", () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  function setupRepo(files: Record<string, string>): string {
    tempDir = mkdtempSync(join(tmpdir(), "cortex-pipeline-"));
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(tempDir, name), content, "utf-8");
    }
    return tempDir;
  }

  it("full rebuild extrai símbolos dos arquivos suportados", async () => {
    const root = setupRepo({
      "a.ts": "export function alpha() {}\n",
      "b.py": "def beta():\n  pass\n",
      "readme.md": "# docs\n",
    });

    const discovery = discoverFiles(root);
    const manifest = buildDiscoveryManifest(root, fingerprintDiscoveredFiles(discovery.files));
    const { index, summary } = await buildStructuralIndex(manifest, root);

    expect(summary.files_parsed).toBe(2);
    expect(index.symbol_count).toBeGreaterThan(0);
    expect(index.coverage_by_language.typescript?.symbols).toBeGreaterThan(0);
    expect(index.coverage_by_language.python?.symbols).toBeGreaterThan(0);
    expect(index.coverage_by_language.typescript?.files_eligible).toBe(1);
    expect(index.coverage_by_language.python?.files_eligible).toBe(1);
    expect(index.files.some((f) => f.relative_path === "readme.md")).toBe(false);
    expect(index.extraction_limitations?.[0]).toContain("não suportada");
  });

  it("rebuild Kotlin produz conjunto equivalente de símbolos (S32)", async () => {
    const root = setupRepo({
      "App.kt": "class App {\n  fun run() {}\n}\n",
    });

    const discovery = discoverFiles(root);
    const manifest = buildDiscoveryManifest(root, fingerprintDiscoveredFiles(discovery.files));
    const first = await buildStructuralIndex(manifest, root);
    const second = await buildStructuralIndex(manifest, root);

    const symbolKeys = (index: typeof first.index) =>
      index.files
        .filter((file) => file.relative_path === "App.kt")
        .flatMap((file) => file.symbols.map((symbol) => `${symbol.kind}:${symbol.name}`))
        .sort();

    expect(symbolKeys(second.index)).toEqual(symbolKeys(first.index));
    expect(first.index.coverage_by_language.kotlin?.coverage_level).toBe("full");
  });

  it("delta add/remove/modify atualiza índice incrementalmente", async () => {
    const root = setupRepo({
      "a.ts": "export function alpha() {}\n",
      "b.ts": "export function beta() {}\n",
    });

    const discovery = discoverFiles(root);
    const manifest = buildDiscoveryManifest(root, fingerprintDiscoveredFiles(discovery.files));
    const full = await buildStructuralIndex(manifest, root);

    writeFileSync(join(root, "a.ts"), "export function alphaChanged() {}\n", "utf-8");
    writeFileSync(join(root, "c.ts"), "export function gamma() {}\n", "utf-8");
    rmSync(join(root, "b.ts"));

    const nextDiscovery = discoverFiles(root);
    const nextManifest = buildDiscoveryManifest(
      root,
      fingerprintDiscoveredFiles(nextDiscovery.files),
    );

    const { index } = await updateStructuralIndexDelta(
      nextManifest,
      root,
      full.index,
      ["a.ts", "c.ts"],
      ["b.ts"],
    );

    const paths = index.files.map((f) => f.relative_path).sort();
    expect(paths).toEqual(["a.ts", "c.ts"]);
    expect(index.files.find((f) => f.relative_path === "a.ts")?.symbols[0]?.name).toBe(
      "alphaChanged",
    );
  });
});
