/**
 * S8 golden `homologate-agent-v1` — jornada agent-facing MCP em dois corpora.
 *
 * Proveniência:
 * - seam: Client+Server reais via InMemoryTransport (sem mock do seam)
 * - corpora: fixtures Q1 corpus-small + corpus-medium
 * - captured: 2026-07-21
 * - command: npm exec --workspace=@owerride/argus -- vitest run tests/homologate-agent.test.ts
 *
 * Regenerar:
 *   UPDATE_GOLDEN=1 npm exec --workspace=@owerride/argus -- vitest run tests/homologate-agent.test.ts
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_LISTED_MCP_TOOLS } from "../src/mcp/tool-registry.js";
import {
  AGENT_RULES_VERSION,
  captureAgentHomologation,
  HOMOLOGATE_AGENT_GOLDEN_PATH,
  HOMOLOGATION_CORPORA,
  runCorpusAgentJourney,
  writeAgentHomologationEvidence,
  type AgentHomologationCapture,
} from "./helpers/run-agent-homologation.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("S8 homologate-agent-v1 (agent-facing MCP)", () => {
  it("AC-6.1.* jornada em dois corpora com golden replay", async () => {
    const results = [];
    for (const spec of HOMOLOGATION_CORPORA) {
      const result = await runCorpusAgentJourney(spec);
      results.push(result);

      // AC-6.1.1
      expect(result.listed_count).toBeLessThanOrEqual(5);
      expect(result.listed_tools).toEqual([...DEFAULT_LISTED_MCP_TOOLS]);
      expect(result.listed_tools).toContain("remember");
      expect(result.explore.actionable).toBe(true);
      expect(result.explore.snippet_body).toContain(spec.probeNeedle);
      expect(["sucesso", "parcial", "stale"]).toContain(result.explore.state);
      expect(result.full_structural_load_count).toBe(0);

      // AC-6.1.2
      expect(["sucesso", "parcial"]).toContain(result.remember_recall.remember_state);
      expect(result.remember_recall.recall_hit).toBe(true);
      expect(result.status.initialized).toBe(true);
      expect(result.status.mcp_slim).toBe(true);
      expect(result.agent_rules.version).toBe(AGENT_RULES_VERSION);
      expect(result.agent_rules.has_happy_path).toBe(true);

      // AC-6.1.3
      expect(result.tool_sequence[0]).toBe("explore");
      expect(result.tool_sequence).toContain("remember");
      expect(result.tool_sequence).toContain("recall");
      expect(result.tool_sequence).toContain("status");
      if (!result.explore.has_retrieve_handle) {
        expect(result.tool_sequence).not.toContain("retrieve");
      }
      expect(result.stdout_write_count).toBe(0);
    }

    expect(results).toHaveLength(2);

    const live = captureAgentHomologation(results, { captured: "2026-07-21" });

    if (process.env.UPDATE_GOLDEN === "1") {
      mkdirSync(dirname(HOMOLOGATE_AGENT_GOLDEN_PATH), { recursive: true });
      writeFileSync(HOMOLOGATE_AGENT_GOLDEN_PATH, `${JSON.stringify(live, null, 2)}\n`, "utf-8");
    }

    if (process.env.HOMOLOGATE_EVIDENCE === "1") {
      writeAgentHomologationEvidence(live, join(REPO_ROOT, ".argus", "homologation"));
    }

    const golden = JSON.parse(
      readFileSync(HOMOLOGATE_AGENT_GOLDEN_PATH, "utf-8"),
    ) as AgentHomologationCapture;

    expect(golden.provenance.id).toBe("homologate-agent-v1");
    expect(golden.provenance.captured).toBeTruthy();
    expect(golden.provenance.command).toContain("homologate-agent.test.ts");
    expect(golden.provenance.corpora).toHaveLength(2);

    for (const spec of HOMOLOGATION_CORPORA) {
      const g = golden.corpora[spec.id];
      const l = live.corpora[spec.id];
      expect(g).toBeDefined();
      expect(l).toBeDefined();
      expect(l!.listed_tools).toEqual(g!.listed_tools);
      expect(l!.listed_count).toBe(g!.listed_count);
      expect(l!.tool_sequence).toEqual(g!.tool_sequence);
      expect(l!.explore_state).toBe(g!.explore_state);
      expect(l!.explore_actionable).toBe(g!.explore_actionable);
      expect(l!.explore_snippet_body).toBe(g!.explore_snippet_body);
      expect(l!.remember_state).toBe(g!.remember_state);
      expect(l!.recall_hit).toBe(g!.recall_hit);
      expect(l!.status_initialized).toBe(g!.status_initialized);
      expect(l!.status_mcp_slim).toBe(g!.status_mcp_slim);
      expect(l!.agent_rules_version).toBe(g!.agent_rules_version);
      expect(l!.full_structural_load_count).toBe(g!.full_structural_load_count);
      expect(l!.stdout_write_count).toBe(g!.stdout_write_count);
      // retrieve_used é condicional; golden registra o valor da captura.
      expect(l!.retrieve_used).toBe(g!.retrieve_used);
    }
  }, 120_000);
});
