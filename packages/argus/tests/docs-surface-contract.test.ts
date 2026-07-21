/**
 * AC-6.2.1 — docs EN/PT descrevem a mesma lista/flags que o código.
 * Confronto automatizado de strings geradas a partir do registry.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ARGUS_MCP_TOOLS_ENV,
  DEFAULT_LISTED_MCP_TOOLS,
  MCP_TOOL_NAMES,
} from "../src/mcp/tool-registry.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");

function readDoc(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), "utf-8");
}

describe("AC-6.2.1 docs surface contract", () => {
  const docs = [
    "README.md",
    "README.pt-BR.md",
    "COMMANDS.md",
    "COMMANDS.pt-BR.md",
  ] as const;

  it("documenta ListTools slim default e override all", () => {
    for (const rel of docs) {
      const body = readDoc(rel);
      for (const tool of DEFAULT_LISTED_MCP_TOOLS) {
        expect(body, `${rel} deve citar ${tool}`).toContain(tool);
      }
      expect(body, `${rel} deve citar ${ARGUS_MCP_TOOLS_ENV}`).toContain(ARGUS_MCP_TOOLS_ENV);
      expect(body, `${rel} deve mencionar override all`).toMatch(/ARGUS_MCP_TOOLS=all|`all`/);
    }
  });

  it("CHANGELOG registra surface slim e compatibilidade CallTool", () => {
    const changelog = readDoc("CHANGELOG.md");
    expect(changelog).toMatch(/ListTools|slim/i);
    expect(changelog).toMatch(/cinco tools|5 tools|no máximo cinco/i);
    expect(changelog).not.toMatch(/\bquatro tools\b|\b4 tools\b|\bno máximo quatro\b/i);
    expect(changelog).toMatch(/CallTool|unlisted|invoc/i);
    expect(changelog).toMatch(/restart|cache/i);
  });

  it("COMMANDS EN/PT documentam install --refresh", () => {
    for (const rel of ["COMMANDS.md", "COMMANDS.pt-BR.md"] as const) {
      const body = readDoc(rel);
      expect(body, `${rel} deve citar install --refresh`).toMatch(/install --refresh/);
    }
  });

  it("AC-6.2.1 README EN/PT citam install --refresh e rejeitam sync pós-remember", () => {
    for (const rel of ["README.md", "README.pt-BR.md"] as const) {
      const body = readDoc(rel);
      expect(body, `${rel} deve citar install --refresh`).toMatch(/install --refresh/);
      // Ritual positivo pós-remember proibido; anti-claim explícito exigido.
      expect(body, `${rel} deve rejeitar memory sync após remember`).toMatch(
        /do \*\*not\*\* run `memory sync` after remember|\*\*não\*\* rode `memory sync` após remember/,
      );
    }
  });

  it("AC-6.2.3 COMMANDS EN/PT distinguem jornada MCP de churn LLM", () => {
    for (const rel of ["COMMANDS.md", "COMMANDS.pt-BR.md"] as const) {
      const body = readDoc(rel);
      expect(body, `${rel} deve citar homologate-agent-v2`).toContain("homologate-agent-v2");
      expect(body, `${rel} deve negar medição de churn LLM`).toMatch(
        /does \*\*not\*\*[\s\S]{0,40}LLM|não\*\* mede churn|NÃO mede churn|does not measure/i,
      );
    }
  });

  it("catálogo registrado permanece 12 nomes canônicos", () => {
    expect(MCP_TOOL_NAMES).toHaveLength(12);
    expect(DEFAULT_LISTED_MCP_TOOLS).toHaveLength(5);
  });
});
