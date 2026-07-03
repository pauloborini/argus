import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runIndex } from "../../src/commands/index-cmd.js";
import { buildIndexEnvelope } from "../../src/mcp/tools/common.js";
import { buildSemanticSearchResponse } from "../../src/mcp/tools/semantic-search.js";
import { buildToolResponse, buildToolResponseAsync } from "../../src/mcp/tools/response.js";
import { MCP_TOOL_NAMES } from "../../src/mcp/tool-registry.js";
import { DreamEngine } from "../../src/memory/dream-engine.js";
import { VaultEngine } from "../../src/memory/vault-engine.js";
import { initWorkspace } from "../../src/workspace/workspace.js";

interface ReleaseClaim {
  id: string;
  status: "passed" | "failed";
  detail: string;
}

interface ReleaseVerdict {
  verdict: "passed" | "failed";
  claims: ReleaseClaim[];
  degradation: {
    no_embeddings: boolean;
    no_llm: boolean;
    workspace_stale: boolean;
  };
  mcp_surface: { count: number; remember: boolean; recall: boolean };
}

interface ReleaseCandidate {
  name?: string;
  path?: string;
  stale_reason?: string;
  confidence?: string;
}

describe("release evaluation aggregate (S08)", () => {
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

  function root(): string {
    originalCwd = process.cwd();
    tempDir = mkdtempSync(join(tmpdir(), "argus-release-eval-"));
    writeFileSync(join(tempDir, "utils.ts"), "export function calculateTotal() { return 1; }\n", "utf-8");
    initWorkspace(tempDir);
    process.chdir(tempDir);
    return tempDir;
  }

  function writeVaultNote(relPath: string, frontmatter: string[], body: string): void {
    const cwd = process.cwd();
    const dir = join(cwd, ".argus", "memory", "vault", relPath.split("/").slice(0, -1).join("/"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(cwd, ".argus", "memory", "vault", relPath),
      [...frontmatter, "---", "", body, ""].join("\n"),
      "utf-8",
    );
  }

  it("produces a clear release verdict for memory+retrieval (S05-S07 package)", async () => {
    const cwd = root();
    VaultEngine.init(cwd);

    writeVaultNote(
      "decision/vigente.md",
      [
        "---",
        'title: "Billing vigente"',
        "type: decision",
        "scope: project",
        "source: direct_capture",
        "confidence: confirmed",
        "observed_at: 2026-01-01T00:00:00.000Z",
      ],
      "billing invoice payment release token",
    );
    writeVaultNote(
      "decision/superseded.md",
      [
        "---",
        'title: "Billing antigo"',
        "type: decision",
        "scope: project",
        "source: direct_capture",
        "confidence: presumed",
        "observed_at: 2025-01-01T00:00:00.000Z",
        "superseded_by: fb00000000000001",
      ],
      "billing invoice legacy release token",
    );
    writeVaultNote(
      "inbox/stale.md",
      [
        "---",
        'title: "Stale inbox"',
        "type: inbox",
        "scope: project",
        "source: direct_capture",
        "confidence: inferred",
        "observed_at: 2026-01-01T00:00:00.000Z",
        'stale_reason: "session_expired"',
      ],
      "stale release evaluation token",
    );
    expect(VaultEngine.sync(cwd).state).toBe("sucesso");
    expect(await runIndex()).toBe(0);
    VaultEngine.init(cwd);

    const claims: ReleaseClaim[] = [];
    const degradation = { no_embeddings: false, no_llm: false, workspace_stale: false };

    const memorySearch = await buildSemanticSearchResponse(
      cwd,
      buildIndexEnvelope(cwd, "lite"),
      { query: "billing invoice payment release", domain: "memory", limit: 5 },
    );
    const memoryCandidates = memorySearch.candidates as ReleaseCandidate[] | undefined;
    const memoryOk =
      ["parcial", "sucesso", "stale"].includes(String(memorySearch.state))
      && Array.isArray(memoryCandidates)
      && memoryCandidates.some((candidate) => candidate.name === "Billing vigente");
    if (memorySearch.state === "parcial") {
      degradation.no_embeddings = true;
    }
    claims.push({
      id: "semantic_search_scoped",
      status: memoryOk ? "passed" : "failed",
      detail: `domain=memory state=${memorySearch.state} candidates=${memoryCandidates?.map((item) => item.name).join(",") ?? "none"}`,
    });

    const recalled = await VaultEngine.recall("billing release", { limit: 10 }, cwd);
    const titles = recalled.chunks.map((chunk) => chunk.title);
    const supersededOk = titles.includes("Billing vigente") && !titles.includes("Billing antigo");
    claims.push({
      id: "supersedence",
      status: supersededOk ? "passed" : "failed",
      detail: `titles=${titles.join(",")}`,
    });

    const staleSearch = await buildSemanticSearchResponse(
      cwd,
      buildIndexEnvelope(cwd, "lite"),
      { query: "stale release evaluation", domain: "memory", limit: 5 },
    );
    const staleCandidate = (staleSearch.candidates as ReleaseCandidate[]).find(
      (item) => item.stale_reason === "session_expired",
    );
    const staleOk =
      Boolean(staleCandidate)
      && staleCandidate?.confidence === "inferred"
      && staleSearch.state !== "sucesso";
    if (staleSearch.state === "stale") {
      degradation.workspace_stale = true;
    }
    claims.push({
      id: "staleness_honest",
      status: staleOk ? "passed" : "failed",
      detail: `stale_reason=${staleCandidate?.stale_reason ?? "none"} state=${staleSearch.state}`,
    });

    const synthesisPayload = await buildToolResponseAsync("pack_context", cwd, {
      sources: ["utils.ts"],
      goal: "release synthesis",
      token_budget: 400,
      style: "balanced",
      synthesize: true,
      response_format: "detailed",
    });
    const synthesis = synthesisPayload.synthesis as {
      state?: string;
      known?: unknown[];
      unknown?: unknown[];
    };
    const noLlmOk = synthesis.state === "parcial" && (synthesis.unknown?.length ?? 0) > 0;
    if (noLlmOk) {
      degradation.no_llm = true;
    }
    claims.push({
      id: "synthesis_without_llm",
      status: noLlmOk ? "passed" : "failed",
      detail: `synthesis.state=${synthesis.state}`,
    });

    const inboxBefore = readdirSync(join(cwd, ".argus", "memory", "vault", "inbox")).length;
    const dream = await DreamEngine.run(cwd, { dryRun: true });
    const inboxAfter = readdirSync(join(cwd, ".argus", "memory", "vault", "inbox")).length;
    const reportsDir = join(cwd, ".argus", "memory", "vault", "reports");
    const reportFiles = existsSync(reportsDir)
      ? readdirSync(reportsDir).filter((file) => file.startsWith("dream-report-"))
      : [];
    const reportText =
      reportFiles.length > 0
        ? readFileSync(join(reportsDir, reportFiles.sort().at(-1)!), "utf-8")
        : "";
    const dreamOk =
      ["sucesso", "parcial"].includes(String(dream.state))
      && inboxBefore === inboxAfter
      && reportFiles.length > 0
      && reportText.toLowerCase().includes("dream");
    claims.push({
      id: "dream_audit_trail",
      status: dreamOk ? "passed" : "failed",
      detail: `dream.state=${dream.state} reports=${reportFiles.length}`,
    });

    const allSearch = await buildSemanticSearchResponse(
      cwd,
      buildIndexEnvelope(cwd, "lite"),
      { query: "calculateTotal release evaluation", domain: "all", limit: 5 },
    );
    const allCandidates = allSearch.candidates as ReleaseCandidate[] | undefined;
    const allOk =
      ["parcial", "sucesso", "stale"].includes(String(allSearch.state))
      && Array.isArray(allCandidates)
      && allCandidates.some((candidate) =>
        candidate.name === "calculateTotal" || candidate.name === "Stale inbox",
      );
    claims.push({
      id: "domain_all",
      status: allOk ? "passed" : "failed",
      detail: `domain=all state=${allSearch.state} candidates=${allCandidates?.map((item) => item.name).join(",") ?? "none"}`,
    });

    const verdict: ReleaseVerdict = {
      verdict: claims.every((claim) => claim.status === "passed") ? "passed" : "failed",
      claims,
      degradation,
      mcp_surface: {
        count: MCP_TOOL_NAMES.length,
        remember: MCP_TOOL_NAMES.includes("remember"),
        recall: MCP_TOOL_NAMES.includes("recall"),
      },
    };

    expect(verdict.mcp_surface).toEqual({ count: 12, remember: true, recall: true });
    expect(verdict.degradation.no_llm).toBe(true);
    const failedClaims = claims.filter((claim) => claim.status === "failed");
    expect(failedClaims, JSON.stringify(failedClaims)).toEqual([]);
    expect(verdict.verdict).toBe("passed");

    const retrieveHandle = buildToolResponse("pack_context", cwd, {
      sources: ["utils.ts"],
      goal: "handle check",
      token_budget: 80,
      style: "deep",
    }).retrieve_handle;
    const opaqueOk = typeof retrieveHandle === "string" && /^rh_[a-f0-9]{16}$/.test(retrieveHandle);
    expect(opaqueOk).toBe(true);
    const badHandle = buildToolResponse("retrieve", cwd, { handle: "mh_notopaquehandle" });
    expect(badHandle.state).toBe("falha");
  });
});
