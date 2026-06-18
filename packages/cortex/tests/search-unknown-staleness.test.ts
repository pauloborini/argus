import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runIndex } from "../src/commands/index-cmd.js";
import { buildToolResponse } from "../src/mcp/tools/response.js";
import { initWorkspace } from "../src/workspace/workspace.js";

// Trava a defesa em buildSearchStub independente de como o "unknown" surge.
// Mesmo quando staleness é genuinamente indeterminada (READ_ERROR ao listar
// diretório, ou MAX_FILE_COUNT em discovery truncado), o índice persistido
// continua válido — search deve devolver candidatos com aviso, nunca zerar.
vi.mock("../src/discovery/staleness.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/discovery/staleness.js")>();
  return {
    ...actual,
    computeManifestStaleness: () => ({ staleness: "unknown" as const, pending_files_count: 0 }),
  };
});

describe("search com staleness indeterminada", () => {
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

  function setupWorkspace(files: Record<string, string>): string {
    originalCwd = process.cwd();
    tempDir = mkdtempSync(join(tmpdir(), "cortex-search-unknown-"));
    for (const [relativePath, content] of Object.entries(files)) {
      const absolutePath = join(tempDir, relativePath);
      mkdirSync(dirname(absolutePath), { recursive: true });
      writeFileSync(absolutePath, content, "utf-8");
    }
    initWorkspace(tempDir);
    process.chdir(tempDir);
    return tempDir;
  }

  it("retorna candidatos com aviso quando staleness é unknown", async () => {
    const root = setupWorkspace({
      "app.ts": "export function calculateTotal() { return 1; }\n",
    });
    expect(await runIndex()).toBe(0);

    const payload = buildToolResponse("search", root, {
      query: "calculateTotal",
      response_format: "detailed",
    });
    expect(payload.state).toBe("parcial");
    const candidates = payload.candidates as Array<{ name: string }>;
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0]?.name).toBe("calculateTotal");
    expect(String(payload.staleness_hint)).toContain("determinar staleness");
  });
});
