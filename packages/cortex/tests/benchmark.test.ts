import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { computePass, copyCorpusSnapshot, scoreUtility } from "../src/benchmark/run-mvp.js";

describe("benchmark summary math", () => {
  it("calcula reduções e utilidade média", () => {
    const totals = computePass([
      {
        id: "BT-01",
        title: "x",
        arm: "baseline",
        repo_label: "repo",
        repo_path: "/tmp/repo",
        snapshot_label: "a",
        tool_calls: 5,
        tokens_aproximados: 1000,
        tempo_ms: 100,
        utilidade_percebida: 4,
        arquivos_citados: [],
        resposta_final: "x",
        incertezas: [],
        observacoes: [],
        steps: [],
      },
      {
        id: "BT-01",
        title: "x",
        arm: "atlas-cortex",
        repo_label: "repo",
        repo_path: "/tmp/repo",
        snapshot_label: "b",
        tool_calls: 3,
        tokens_aproximados: 600,
        tempo_ms: 80,
        utilidade_percebida: 5,
        arquivos_citados: [],
        resposta_final: "x",
        incertezas: [],
        observacoes: [],
        steps: [],
      },
      {
        id: "BT-02",
        title: "y",
        arm: "baseline",
        repo_label: "repo",
        repo_path: "/tmp/repo",
        snapshot_label: "a",
        tool_calls: 4,
        tokens_aproximados: 800,
        tempo_ms: 110,
        utilidade_percebida: 4,
        arquivos_citados: [],
        resposta_final: "y",
        incertezas: [],
        observacoes: [],
        steps: [],
      },
      {
        id: "BT-02",
        title: "y",
        arm: "atlas-cortex",
        repo_label: "repo",
        repo_path: "/tmp/repo",
        snapshot_label: "b",
        tool_calls: 2,
        tokens_aproximados: 400,
        tempo_ms: 70,
        utilidade_percebida: 4,
        arquivos_citados: [],
        resposta_final: "y",
        incertezas: [],
        observacoes: [],
        steps: [],
      },
    ]);

    expect(totals.baseline_tool_calls).toBe(9);
    expect(totals.atlas_tool_calls).toBe(5);
    expect(totals.baseline_tokens).toBe(1800);
    expect(totals.atlas_tokens).toBe(1000);
    expect(totals.tool_call_reduction_pct).toBeCloseTo(44.44, 1);
    expect(totals.token_reduction_pct).toBeCloseTo(44.44, 1);
    expect(totals.baseline_average_utility).toBe(4);
    expect(totals.atlas_average_utility).toBe(4.5);
    expect(totals.minimum_atlas_utility).toBe(4);
  });

  it("limita utilidade quando faltam refs suficientes", () => {
    expect(scoreUtility("resposta longa o bastante para o benchmark".repeat(4), [], [], true)).toBe(2);
    expect(scoreUtility("resposta longa o bastante para o benchmark".repeat(4), ["a.ts"], [], true)).toBe(3);
    expect(scoreUtility("resposta longa o bastante para o benchmark".repeat(4), ["a.ts", "b.ts"], [], true)).toBe(4);
  });

  it("copia corpus sem carregar .cortex do archive original", () => {
    const root = mkdtempSync(join(tmpdir(), "atlas-cortex-bench-"));
    const source = join(root, "source");
    const target = join(root, "target");
    mkdirSync(join(source, ".cortex"), { recursive: true });
    mkdirSync(join(source, "src"), { recursive: true });
    writeFileSync(join(source, ".cortex", "manifest.json"), "{\"ok\":true}\n", "utf-8");
    writeFileSync(join(source, "src", "index.ts"), "export const ok = true;\n", "utf-8");

    copyCorpusSnapshot(source, target);

    expect(() => mkdirSync(join(target, ".cortex"), { recursive: false })).not.toThrow();
  });
});
