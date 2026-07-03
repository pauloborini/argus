import { stubResponse } from "../contracts/response-state.js";
import { DEFAULT_MAX_CONTEXT_TOKENS, loadMemoryConfig } from "./config.js";
import { analyzeSynthesisGaps, type GapAnalysisSource } from "./gap-analyzer.js";
import { createLlmProvider, LlmProviderError } from "./llm-provider.js";
import { openMemoryDb, closeMemoryDb } from "./storage/sqlite-db.js";
import {
  buildCitationsFromPack,
  buildHandles,
  createHonestSynthesis,
  memoryCitationId,
  normalizeKnownItems,
  parseLlmStructuredSynthesis,
  mergeUnknown,
  type HonestSynthesis,
  type PackSynthesisEvidence,
} from "./synthesis-contract.js";
import { VaultEngine, type MemorySearchResult } from "./vault-engine.js";

export interface ThinkOptions {
  context?: string;
  dryRun?: boolean;
  cwd?: string;
  packEvidence?: PackSynthesisEvidence;
}

interface MemorySynthesisSource extends GapAnalysisSource {
  mechanism?: string;
}

function packedMemoryLookupKeys(evidence: PackSynthesisEvidence | undefined): string[] {
  const keys = new Set<string>();
  for (const ref of evidence?.origin_refs ?? []) {
    if (ref.path.startsWith("memory/")) {
      keys.add(ref.path.slice("memory/".length));
    }
    if (ref.ref.startsWith("memory:")) {
      keys.add(ref.ref.slice("memory:".length).replace(/^\/+/, ""));
    }
    if (ref.ref.startsWith("note:")) {
      keys.add(ref.ref.slice("note:".length).trim());
    }
  }
  return Array.from(keys).filter((key) => key.length > 0);
}

function readPackedMemorySources(cwd: string, evidence: PackSynthesisEvidence | undefined): MemorySynthesisSource[] {
  const keys = packedMemoryLookupKeys(evidence);
  if (keys.length === 0) {
    return [];
  }

  try {
    const db = openMemoryDb(cwd, { readonly: true });
    try {
      const sources: MemorySynthesisSource[] = [];
      const stmt = db.prepare(
        `SELECT path, title, content, stale_reason, contradiction_reason
         FROM notes
         WHERE path = ? OR id = ?
         LIMIT 1`,
      );
      for (const key of keys) {
        const row = stmt.get(key, key) as
          | {
              path: string;
              title: string;
              content: string;
              stale_reason: string | null;
              contradiction_reason: string | null;
            }
          | undefined;
        if (!row) {
          continue;
        }
        sources.push({
          title: row.title,
          path: row.path,
          snippet: row.content.slice(0, 500),
          stale_reason: row.stale_reason ?? undefined,
          contradiction_reason: row.contradiction_reason ?? undefined,
          citation_id: memoryCitationId(row.path),
          mechanism: "packed-source",
        });
      }
      return sources;
    } finally {
      closeMemoryDb(db);
    }
  } catch {
    return [];
  }
}

function mergeMemorySources(sources: MemorySynthesisSource[]): MemorySynthesisSource[] {
  const byPath = new Map<string, MemorySynthesisSource>();
  for (const source of sources) {
    const key = source.path ?? source.title;
    const current = byPath.get(key);
    if (!current) {
      byPath.set(key, source);
      continue;
    }
    byPath.set(key, {
      ...current,
      snippet: current.snippet ?? source.snippet,
      stale_reason: current.stale_reason ?? source.stale_reason,
      contradiction_reason: current.contradiction_reason ?? source.contradiction_reason,
      citation_id: current.citation_id ?? source.citation_id,
      mechanism: current.mechanism ?? source.mechanism,
    });
  }
  return Array.from(byPath.values());
}

export class ThinkEngine {
  static async think(goal: string, options: ThinkOptions = {}): Promise<HonestSynthesis> {
    const cwd = options.cwd ?? process.cwd();
    const config = loadMemoryConfig(cwd);
    const maxContextTokens = config?.max_context_tokens ?? DEFAULT_MAX_CONTEXT_TOKENS;
    const evidence = options.packEvidence;

    let memoryChunks: MemorySearchResult[] = [];
    const recalled = await VaultEngine.recall(goal, { limit: 10, includeContent: true }, cwd);
    memoryChunks = recalled.chunks;
    const memorySources = mergeMemorySources([
      ...readPackedMemorySources(cwd, evidence),
      ...memoryChunks.map((chunk) => ({
        title: chunk.title,
        path: chunk.path,
        snippet: chunk.snippet,
        stale_reason: chunk.stale_reason,
        contradiction_reason: chunk.contradiction_reason,
        citation_id: memoryCitationId(chunk.path),
        mechanism: chunk.mechanism,
      })),
    ]);

    const memoryPaths = memorySources.map((source) => ({
      path: source.path ?? source.title,
      title: source.title,
      mechanism: source.mechanism,
    }));
    const citations = buildCitationsFromPack(evidence, memoryPaths);
    const handles = buildHandles(evidence);

    const gapSources: GapAnalysisSource[] = memorySources;

    const providerLimitations = [...(evidence?.limitations ?? [])];
    if (evidence?.staleness_hint) {
      providerLimitations.push(`Índice stale: ${evidence.staleness_hint}`);
    }

    const gapResult = analyzeSynthesisGaps(
      goal,
      gapSources,
      (evidence?.removed_or_summarized ?? []).map((item) => ({
        ref: item.ref,
        action: item.action,
        reason: item.reason,
        via_handle: item.via_handle,
      })),
      providerLimitations,
    );

    const context =
      options.context ??
      memoryChunks.map((chunk) => `[Nota: ${chunk.path}]\n${chunk.content ?? chunk.snippet}`).join("\n\n");
    const boundedContext =
      context.length / 4 > maxContextTokens ? context.slice(0, maxContextTokens * 4) : context;

    const prompt = [
      "Responda APENAS com JSON válido no formato:",
      '{"known":[{"text":"...","citation_ids":["cite_origin_0"]}],"unknown":[{"text":"...","reason":"..."}]}',
      "Regras: toda entrada em known precisa citation_ids existentes no contexto; sem suporte vira unknown.",
      "",
      `Citações disponíveis: ${citations.map((item) => item.id).join(", ") || "nenhuma"}`,
      "",
      `Pergunta: ${goal}`,
      "",
      `Contexto:\n${boundedContext}`,
    ].join("\n");

    const baseBody = {
      known: [] as HonestSynthesis["known"],
      unknown: gapResult.unknown,
      contradictions: gapResult.contradictions,
      stale_sources: gapResult.stale_sources,
      citations,
      handles,
    };

    if (options.dryRun) {
      return createHonestSynthesis(goal, "sucesso", "Síntese dry-run montada.", {
        ...baseBody,
        dry_run_prompt: prompt,
      });
    }

    if (!config || config.llm_provider === "none") {
      return createHonestSynthesis(
        goal,
        "parcial",
        "W_SYNTHESIS_UNAVAILABLE: llm_provider não configurado.",
        {
          ...baseBody,
          unknown: mergeUnknown(baseBody.unknown, [
            { text: "Síntese LLM indisponível; configure .argus/memory/config.json.", reason: "llm_unavailable" },
          ]),
        },
        { limitations: ["Configure .argus/memory/config.json para habilitar síntese LLM."] },
      );
    }

    try {
      const answer = await createLlmProvider(config).complete(prompt);
      const parsed = parseLlmStructuredSynthesis(answer);
      const normalized = normalizeKnownItems(parsed.known, citations);
      const staleOrContradictoryIds = new Set([
        ...gapResult.stale_sources.map((item) => item.citation_id),
        ...gapResult.contradictions.flatMap((item) => item.citation_ids),
      ]);
      const known = normalized.known.filter((item) =>
        item.citation_ids.every((id) => !staleOrContradictoryIds.has(id)),
      );
      const rejectedFromStale = normalized.known
        .filter((item) => item.citation_ids.some((id) => staleOrContradictoryIds.has(id)))
        .map((item) => ({
          text: item.text,
          reason: "fonte_stale_ou_contraditoria",
          citation_ids: item.citation_ids,
        }));

      const unknown = mergeUnknown(baseBody.unknown, [...parsed.unknown, ...normalized.rejected, ...rejectedFromStale]);
      const synthesisState =
        unknown.length > 0 || gapResult.stale_sources.length > 0 || gapResult.contradictions.length > 0
          ? "parcial"
          : "sucesso";

      return createHonestSynthesis(goal, synthesisState, "Síntese concluída.", {
        ...baseBody,
        known,
        unknown,
      });
    } catch (err) {
      const message =
        err instanceof LlmProviderError ? `${err.code}: ${err.message}` : err instanceof Error ? err.message : String(err);
      return createHonestSynthesis(
        goal,
        "parcial",
        message,
        {
          ...baseBody,
          unknown: mergeUnknown(baseBody.unknown, [
            { text: "Síntese LLM falhou; contexto e gaps preservados.", reason: "llm_failed" },
          ]),
        },
        { limitations: ["Síntese LLM indisponível; contexto e gaps retornados."] },
      );
    }
  }
}

// Re-export for callers that still import stubResponse patterns from think path.
export { stubResponse };
