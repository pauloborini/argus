import type {
  SynthesisContradiction,
  SynthesisStaleSource,
  SynthesisUnknown,
} from "./synthesis-contract.js";

const STOPWORDS = new Set([
  "como",
  "para",
  "com",
  "uma",
  "dos",
  "das",
  "que",
  "sobre",
  "qual",
  "quais",
  "onde",
  "quando",
  "quem",
  "este",
  "esta",
  "isso",
  "isto",
  "pelo",
  "pela",
  "what",
  "with",
  "this",
  "that",
  "these",
  "those",
  "from",
  "about",
  "their",
]);

export interface GapAnalysisSource {
  title: string;
  path?: string;
  tags?: string[];
  snippet?: string;
  stale_reason?: string;
  contradiction_reason?: string;
  citation_id?: string;
}

export interface GapAnalysisBudgetLoss {
  ref: string;
  action: "removed" | "summarized" | "deduplicated";
  reason: "budget" | "low_relevance" | "duplicate";
  via_handle?: string;
}

export interface SynthesisGapResult {
  unknown: SynthesisUnknown[];
  contradictions: SynthesisContradiction[];
  stale_sources: SynthesisStaleSource[];
}

export function analyzeGaps(query: string, notes: { title: string; tags?: string[] }[]): string[] {
  if (!query.trim()) {
    return [];
  }
  const terms = Array.from(
    new Set(
      query
        .toLowerCase()
        .split(/[\s,.;:!?()"'"`\-+/\\_]+/g)
        .map((word) => word.trim())
        .filter((word) => word.length >= 4 && !STOPWORDS.has(word)),
    ),
  );
  if (terms.length === 0) {
    return notes.length === 0 ? [query.trim()] : [];
  }
  return terms.filter((term) =>
    !notes.some((note) =>
      note.title.toLowerCase().includes(term) ||
      (note.tags ?? []).some((tag) => tag.toLowerCase().includes(term)),
    ),
  );
}

function noteMatchesTerm(source: GapAnalysisSource, term: string): boolean {
  const haystack = [
    source.title,
    source.path ?? "",
    source.snippet ?? "",
    ...(source.tags ?? []),
  ]
    .join(" ")
    .toLowerCase();
  return haystack.includes(term);
}

export function analyzeSynthesisGaps(
  query: string,
  sources: GapAnalysisSource[],
  budgetLoss: GapAnalysisBudgetLoss[] = [],
  providerLimitations: string[] = [],
): SynthesisGapResult {
  const unknown: SynthesisUnknown[] = [];
  const contradictions: SynthesisContradiction[] = [];
  const stale_sources: SynthesisStaleSource[] = [];

  for (const source of sources) {
    if (!source.citation_id) {
      continue;
    }
    if (source.contradiction_reason?.trim()) {
      contradictions.push({
        text: source.title,
        reason: source.contradiction_reason.trim(),
        citation_ids: [source.citation_id],
      });
    }
    if (source.stale_reason?.trim()) {
      stale_sources.push({
        citation_id: source.citation_id,
        reason: source.stale_reason.trim(),
      });
    }
  }

  const coverageTerms = analyzeGaps(query, sources);
  for (const term of coverageTerms) {
    const covered = sources.some((source) => noteMatchesTerm(source, term));
    if (!covered) {
      unknown.push({ text: `Cobertura ausente para termo: ${term}`, reason: "coverage_gap" });
    }
  }

  for (const loss of budgetLoss) {
    const text =
      loss.action === "summarized"
        ? `Material resumido por budget: ${loss.ref}`
        : loss.action === "removed"
          ? `Material removido por budget: ${loss.ref}`
          : `Material deduplicado: ${loss.ref}`;
    unknown.push({
      text,
      reason: loss.reason === "budget" ? "budget_truncation" : loss.reason,
      handle: loss.via_handle,
    });
  }

  for (const limitation of providerLimitations) {
    unknown.push({ text: limitation, reason: "provider_limitation" });
  }

  if (sources.length === 0 && query.trim()) {
    unknown.push({ text: "Nenhuma fonte de memória recuperada para o objetivo.", reason: "no_memory_sources" });
  }

  return { unknown, contradictions, stale_sources };
}
