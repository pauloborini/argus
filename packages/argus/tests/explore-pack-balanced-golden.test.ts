/**
 * Golden S3 `explore-pack-balanced-v1` — prova ancorada do pipeline real.
 *
 * Proveniência:
 * - origin: packages/argus explore/pack builders (sem mock do seam)
 * - captured: 2026-07-21
 * - command: npm exec --workspace=@owerride/argus -- vitest run tests/explore-pack-balanced-golden.test.ts
 * - fixture: utils.ts + dep.ts (mesmo corpus dos testes explore/pack)
 * - budget: pack token_budget=400, style=balanced; explore default=balanced
 *
 * Regenerar (quando contrato mudar de propósito):
 *   UPDATE_GOLDEN=1 npm exec --workspace=@owerride/argus -- vitest run tests/explore-pack-balanced-golden.test.ts
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runIndex } from "../src/commands/index-cmd.js";
import { buildToolResponse } from "../src/mcp/tools/response.js";
import { initWorkspace } from "../src/workspace/workspace.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN_PATH = join(HERE, "fixtures/goldens/explore-pack-balanced-v1.json");

interface GoldenPayload {
  provenance: {
    id: string;
    captured: string;
    command: string;
    fixture: string;
    budget: { pack_token_budget: number; style: string };
  };
  explore: {
    state: string;
    snippet_signature: string;
    snippet_body: string;
    relevant_files_count: number;
  };
  pack: {
    state: string;
    packed_context: string;
    origin_refs_count: number;
  };
}

describe("golden explore-pack-balanced-v1 (S3)", () => {
  let tempDir: string | undefined;
  let originalCwd: string | undefined;

  afterEach(() => {
    if (originalCwd) {
      process.chdir(originalCwd);
      originalCwd = undefined;
    }
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  function setup(): string {
    originalCwd = process.cwd();
    tempDir = mkdtempSync(join(tmpdir(), "argus-golden-balanced-"));
    writeFileSync(
      join(tempDir, "utils.ts"),
      'import { helper } from "./dep";\nexport function calculateTotal() { helper(); return 1; }\n',
      "utf-8",
    );
    writeFileSync(join(tempDir, "dep.ts"), "export function helper() { return 1; }\n", "utf-8");
    initWorkspace(tempDir);
    process.chdir(tempDir);
    return tempDir;
  }

  /** Captura campos observáveis reais do pipeline — sem needles hardcodados. */
  function capture(root: string): GoldenPayload {
    const explore = buildToolResponse("explore", root, {
      target: "calculateTotal",
      mode: "symbol",
    });
    const pack = buildToolResponse("pack_context", root, {
      sources: ["utils.ts"],
      goal: "entender refactor",
      token_budget: 400,
      style: "balanced",
    });
    const snippet = (explore.snippets as Array<{ signature?: string; body?: string }>)[0];

    return {
      provenance: {
        id: "explore-pack-balanced-v1",
        captured: "2026-07-21",
        command:
          "npm exec --workspace=@owerride/argus -- vitest run tests/explore-pack-balanced-golden.test.ts",
        fixture: "utils.ts + dep.ts (calculateTotal/helper)",
        budget: { pack_token_budget: 400, style: "balanced" },
      },
      explore: {
        state: String(explore.state),
        snippet_signature: String(snippet?.signature ?? ""),
        snippet_body: String(snippet?.body ?? ""),
        relevant_files_count: ((explore.relevant_files as unknown[]) ?? []).length,
      },
      pack: {
        state: String(pack.state),
        packed_context: String(pack.packed_context),
        origin_refs_count: ((pack.origin_refs as unknown[]) ?? []).length,
      },
    };
  }

  it("pipeline real produz contrato balanced acionável alinhado ao golden", async () => {
    const root = setup();
    expect(await runIndex()).toBe(0);

    const live = capture(root);

    // Contrato mínimo ancorado no seam (independente do arquivo golden).
    expect(["sucesso", "parcial", "stale"]).toContain(live.explore.state);
    expect(live.explore.snippet_signature).toContain("calculateTotal");
    expect(live.explore.snippet_body).toContain("return 1");
    expect(live.explore.snippet_body).toContain("helper()");
    expect(live.explore.relevant_files_count).toBeGreaterThan(0);
    expect(live.pack.packed_context).toContain("calculateTotal");
    expect(live.pack.packed_context).toContain("return 1");
    expect(live.pack.packed_context).toMatch(/Snippet utils\.ts:/);
    expect(live.pack.origin_refs_count).toBeGreaterThanOrEqual(1);

    if (process.env.UPDATE_GOLDEN === "1") {
      mkdirSync(dirname(GOLDEN_PATH), { recursive: true });
      writeFileSync(GOLDEN_PATH, `${JSON.stringify(live, null, 2)}\n`, "utf-8");
    }

    const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf-8")) as GoldenPayload;
    expect(golden.provenance.id).toBe("explore-pack-balanced-v1");
    expect(golden.provenance.captured).toBeTruthy();
    expect(golden.provenance.command).toBeTruthy();
    expect(golden.provenance.budget).toEqual({ pack_token_budget: 400, style: "balanced" });
    // Replay: bytes observáveis do pipeline == captura registrada.
    expect(live.explore.state).toBe(golden.explore.state);
    expect(live.explore.snippet_signature).toBe(golden.explore.snippet_signature);
    expect(live.explore.snippet_body).toBe(golden.explore.snippet_body);
    expect(live.explore.relevant_files_count).toBe(golden.explore.relevant_files_count);
    expect(live.pack.state).toBe(golden.pack.state);
    expect(live.pack.packed_context).toBe(golden.pack.packed_context);
    expect(live.pack.origin_refs_count).toBe(golden.pack.origin_refs_count);
  });
});
