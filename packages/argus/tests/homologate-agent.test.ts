/**
 * S8v2 golden `homologate-agent-v2` — jornada MCP (não churn LLM).
 *
 * Proveniência:
 * - seam: Client+Server reais via InMemoryTransport (sem mock do seam) — H6
 * - corpora: corpus-small + corpus-medium + corpus-stress (símbolo > caps)
 * - captured: 2026-07-21
 * - command: npm exec --workspace=@owerride/argus -- vitest run tests/homologate-agent.test.ts
 * - nível: jornada MCP in-process; NÃO mede churn de agente LLM (INV-H6 / D8)
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

describe("S8v2 homologate-agent-v2 (MCP journey)", () => {
  it("AC-6.1.* jornada truncate→retrieve + remember→recall com golden replay", async () => {
    const results = [];
    for (const spec of HOMOLOGATION_CORPORA) {
      const result = await runCorpusAgentJourney(spec);
      results.push(result);

      // AC-6.1.3 — ListTools inclui remember; ≤5 slim
      expect(result.listed_count).toBeLessThanOrEqual(5);
      expect(result.listed_tools).toEqual([...DEFAULT_LISTED_MCP_TOOLS]);
      expect(result.listed_tools).toContain("remember");

      // AC-6.1.1 — truncado ⇒ retrieve_used; não-truncado ⇒ retrieve opcional
      if (spec.expectTruncate || result.explore.truncated) {
        expect(result.explore.truncated).toBe(true);
        expect(result.explore.has_retrieve_handle).toBe(true);
        expect(result.explore.retrieved).toBe(true);
        expect(result.tool_sequence).toContain("retrieve");
        // Snippet truncado não deve bastar com o needle (prova de que retrieve importa)
        expect(result.explore.needle_in_snippet).toBe(false);
      } else {
        expect(result.explore.retrieved).toBe(false);
        expect(result.tool_sequence).not.toContain("retrieve");
        expect(result.explore.needle_in_snippet).toBe(true);
      }

      // AC-6.1.2 — needle ⊆ corpo expandido pós-retrieve (ou snippet se não truncou)
      expect(result.explore.actionable).toBe(true);
      if (result.explore.retrieved) {
        expect(result.explore.needle_in_retrieve).toBe(true);
        expect(result.explore.retrieved_body).toContain(spec.probeNeedle);
      } else {
        expect(result.explore.snippet_body).toContain(spec.probeNeedle);
      }

      expect(["sucesso", "parcial", "stale"]).toContain(result.explore.state);
      expect(result.full_structural_load_count).toBe(0);

      // AC-6.1.3 — remember→recall same-session sem sync
      expect(["sucesso", "parcial"]).toContain(result.remember_recall.remember_state);
      expect(result.remember_recall.recall_hit).toBe(true);
      expect(result.remember_recall.sync_called).toBe(false);
      expect(result.tool_sequence).not.toContain("sync");
      expect(result.status.initialized).toBe(true);
      expect(result.status.mcp_slim).toBe(true);
      expect(result.agent_rules.version).toBe(AGENT_RULES_VERSION);
      expect(result.agent_rules.has_happy_path).toBe(true);

      expect(result.tool_sequence[0]).toBe("explore");
      expect(result.tool_sequence).toContain("remember");
      expect(result.tool_sequence).toContain("recall");
      expect(result.tool_sequence).toContain("status");
      expect(result.stdout_write_count).toBe(0);
    }

    expect(results).toHaveLength(HOMOLOGATION_CORPORA.length);
    expect(results.some((r) => r.explore.truncated && r.explore.retrieved)).toBe(true);

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

    expect(golden.provenance.id).toBe("homologate-agent-v2");
    expect(golden.provenance.captured).toBeTruthy();
    expect(golden.provenance.command).toContain("homologate-agent.test.ts");
    expect(golden.provenance.level).toMatch(/jornada MCP|MCP journey/i);
    // INV-H6: nível declara honestamente que NÃO mede churn LLM.
    expect(golden.provenance.level).toMatch(/NÃO mede churn LLM|does not measure.*LLM churn/i);
    expect(golden.provenance.notes).toMatch(/jornada MCP|MCP journey/i);
    expect(golden.provenance.notes).toMatch(/não agent-facing LLM churn|não mede.*LLM churn|NÃO mede/i);
    expect(golden.provenance.corpora).toHaveLength(HOMOLOGATION_CORPORA.length);

    for (const spec of HOMOLOGATION_CORPORA) {
      const g = golden.corpora[spec.id];
      const l = live.corpora[spec.id];
      expect(g).toBeDefined();
      expect(l).toBeDefined();
      expect(l!.listed_tools).toEqual(g!.listed_tools);
      expect(l!.listed_count).toBe(g!.listed_count);
      expect(l!.tool_sequence).toEqual(g!.tool_sequence);
      expect(l!.explore_state).toBe(g!.explore_state);
      expect(l!.explore_truncated).toBe(g!.explore_truncated);
      expect(l!.explore_actionable).toBe(g!.explore_actionable);
      expect(l!.explore_snippet_body).toBe(g!.explore_snippet_body);
      expect(l!.retrieve_used).toBe(g!.retrieve_used);
      expect(l!.needle_in_snippet).toBe(g!.needle_in_snippet);
      expect(l!.needle_in_retrieve).toBe(g!.needle_in_retrieve);
      expect(l!.remember_state).toBe(g!.remember_state);
      expect(l!.recall_hit).toBe(g!.recall_hit);
      expect(l!.sync_called).toBe(g!.sync_called);
      expect(l!.status_initialized).toBe(g!.status_initialized);
      expect(l!.status_mcp_slim).toBe(g!.status_mcp_slim);
      expect(l!.agent_rules_version).toBe(g!.agent_rules_version);
      expect(l!.full_structural_load_count).toBe(g!.full_structural_load_count);
      expect(l!.stdout_write_count).toBe(g!.stdout_write_count);
    }

    // Stress corpus no golden: truncate + retrieve obrigatórios
    const stress = golden.corpora["corpus-stress"];
    expect(stress?.explore_truncated).toBe(true);
    expect(stress?.retrieve_used).toBe(true);
    expect(stress?.needle_in_retrieve).toBe(true);
    expect(stress?.needle_in_snippet).toBe(false);
  }, 180_000);
});
