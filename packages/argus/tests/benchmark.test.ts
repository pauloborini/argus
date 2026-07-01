import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  approxTokens,
  compactSerialize,
  computeSummary,
  computeTotals,
  copyCorpusSnapshot,
  evaluateAnswer,
} from "../src/benchmark/run-mvp.js";

type Arm = "baseline" | "formato-so" | "argus";

function task(id: string, arm: Arm, kind: "cirurgica" | "varredura", tokens: number, toolCalls: number, correct: boolean) {
  return {
    id,
    title: id,
    kind,
    arm,
    repo_label: "repo",
    repo_path: "/tmp/repo",
    tool_calls: toolCalls,
    tokens,
    tempo_ms: 1,
    correct,
    cited_expected: correct ? 2 : 1,
    expected_total: 2,
    uncertainty_disclosed: arm === "argus",
    steps: [],
  };
}

describe("approxTokens (heurística aproximada)", () => {
  it("é determinística e cresce com o texto", () => {
    expect(approxTokens("")).toBe(0);
    expect(approxTokens("getImpactRadius")).toBeGreaterThan(1); // quebra camelCase
    expect(approxTokens("aaaa".repeat(50))).toBeGreaterThan(approxTokens("aaaa"));
  });

  it("não é o piso chars/4: código denso conta mais subtokens", () => {
    const code = "const x = foo.bar(baz, qux);";
    expect(approxTokens(code)).toBeGreaterThan(Math.ceil(code.length / 4) - 1);
  });
});

describe("compactSerialize (arm formato-só)", () => {
  it("remove prefixo de linha, indentação e colapsa linhas em branco", () => {
    const raw = "123:    const x = 1;\n\n\n456:    const y = 2;";
    const out = compactSerialize(raw);
    expect(out).toBe("const x = 1;\n\nconst y = 2;");
    expect(approxTokens(out)).toBeLessThan(approxTokens(raw));
  });
});

describe("evaluateAnswer (checagem objetiva)", () => {
  it("correto quando todos os arquivos e o símbolo aparecem na saída real", () => {
    const out = "// FILE: src/a.ts\nfunction getImpactRadius() {}\n// FILE: src/b.ts";
    const r = evaluateAnswer(out, { mustCite: ["src/a.ts", "src/b.ts"], mustContainSymbol: "getImpactRadius" });
    expect(r.correct).toBe(true);
    expect(r.citedExpected).toBe(2);
  });

  it("incorreto quando falta arquivo ou símbolo", () => {
    const out = "// FILE: src/a.ts";
    expect(evaluateAnswer(out, { mustCite: ["src/a.ts", "src/b.ts"] }).correct).toBe(false);
    expect(evaluateAnswer(out, { mustCite: ["src/a.ts"], mustContainSymbol: "ausente" }).correct).toBe(false);
  });

  it("mede uncertainty disclosure (não fixa em true)", () => {
    expect(evaluateAnswer("payload normal", { mustCite: [] }).uncertaintyDisclosed).toBe(false);
    expect(evaluateAnswer("W_STALE_INDEX detectado", { mustCite: [] }).uncertaintyDisclosed).toBe(true);
  });
});

describe("computeTotals / computeSummary (3 arms)", () => {
  it("calcula ganhos de formato, índice e headline", () => {
    const tasks = [
      task("BT-01", "baseline", "cirurgica", 1000, 3, true),
      task("BT-01", "formato-so", "cirurgica", 800, 3, true),
      task("BT-01", "argus", "cirurgica", 200, 2, true),
      task("BT-02", "baseline", "varredura", 1000, 2, true),
      task("BT-02", "formato-so", "varredura", 900, 2, true),
      task("BT-02", "argus", "varredura", 600, 2, true),
    ];
    const totals = computeTotals(tasks);
    expect(totals.baseline.tokens).toBe(2000);
    expect(totals["formato-so"].tokens).toBe(1700);
    expect(totals.argus.tokens).toBe(800);

    const summary = computeSummary(tasks, "/tmp/out");
    expect(summary.gains.format_token_pct).toBeCloseTo(15, 1); // 2000→1700
    expect(summary.gains.index_token_pct).toBeCloseTo(52.94, 1); // 1700→800
    expect(summary.gains.headline_token_pct).toBeCloseTo(60, 1); // 2000→800
    expect(summary.by_kind.cirurgica.headline_token_pct).toBeCloseTo(80, 1); // 1000→200
    expect(summary.by_kind.varredura.headline_token_pct).toBeCloseTo(40, 1); // 1000→600
    expect(summary.pass).toBe(true); // todas corretas no argus + headline positivo
  });

  it("falha o gate quando o argus não surfa o ground-truth", () => {
    const tasks = [
      task("BT-01", "baseline", "cirurgica", 1000, 3, true),
      task("BT-01", "formato-so", "cirurgica", 800, 3, true),
      task("BT-01", "argus", "cirurgica", 200, 2, false),
    ];
    expect(computeSummary(tasks, "/tmp/out").pass).toBe(false);
  });
});

describe("copyCorpusSnapshot", () => {
  it("copia corpus sem carregar .argus do archive original", () => {
    const root = mkdtempSync(join(tmpdir(), "argus-bench-"));
    const source = join(root, "source");
    const target = join(root, "target");
    mkdirSync(join(source, ".argus"), { recursive: true });
    mkdirSync(join(source, "src"), { recursive: true });
    writeFileSync(join(source, ".argus", "manifest.json"), "{\"ok\":true}\n", "utf-8");
    writeFileSync(join(source, "src", "index.ts"), "export const ok = true;\n", "utf-8");

    copyCorpusSnapshot(source, target);

    expect(() => mkdirSync(join(target, ".argus"), { recursive: false })).not.toThrow();
  });
});
