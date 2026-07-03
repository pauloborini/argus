import type { ResponseState } from "../contracts/response-state.js";
import { stubResponse } from "../contracts/response-state.js";
import type { PackOriginRef, PackRemovedEntry } from "../mcp/tools/common.js";
import type { ToolResponsePayload } from "../mcp/tools/common.js";

export interface SynthesisCitation {
  id: string;
  path?: string;
  handle?: string;
  symbol?: string;
  start_line?: number;
  end_line?: number;
  source?: string;
  mechanism?: string;
}

export interface SynthesisKnown {
  text: string;
  citation_ids: string[];
}

export interface SynthesisUnknown {
  text: string;
  reason?: string;
  citation_ids?: string[];
  handle?: string;
}

export interface SynthesisContradiction {
  text: string;
  reason: string;
  citation_ids: string[];
}

export interface SynthesisStaleSource {
  citation_id: string;
  reason: string;
}

export interface SynthesisHandles {
  retrieve_handle?: string;
}

export interface PackSynthesisEvidence {
  origin_refs?: PackOriginRef[];
  retrieve_handle?: string;
  removed_or_summarized?: PackRemovedEntry[];
  limitations?: string[];
  staleness_hint?: string;
  reversibility?: string;
}

export interface HonestSynthesisPayload {
  goal: string;
  known: SynthesisKnown[];
  unknown: SynthesisUnknown[];
  contradictions: SynthesisContradiction[];
  stale_sources: SynthesisStaleSource[];
  citations: SynthesisCitation[];
  handles: SynthesisHandles;
  dry_run_prompt?: string;
}

export type HonestSynthesis = HonestSynthesisPayload & ToolResponsePayload;

export function originCitationId(index: number): string {
  return `cite_origin_${index}`;
}

export function memoryCitationId(path: string): string {
  return `cite_mem_${path.replace(/[^a-zA-Z0-9]+/g, "_").slice(0, 48)}`;
}

export function buildCitationsFromPack(
  evidence: PackSynthesisEvidence | undefined,
  memoryPaths: Array<{ path: string; title: string; mechanism?: string }>,
): SynthesisCitation[] {
  const citations: SynthesisCitation[] = [];
  for (const [index, ref] of (evidence?.origin_refs ?? []).entries()) {
    citations.push({
      id: originCitationId(index),
      path: ref.path,
      symbol: ref.symbol,
      start_line: ref.start_line,
      end_line: ref.end_line,
      source: ref.ref,
    });
  }
  for (const note of memoryPaths) {
    const id = memoryCitationId(note.path);
    if (!citations.some((item) => item.id === id)) {
      citations.push({
        id,
        path: note.path,
        source: `memory:${note.path}`,
        mechanism: note.mechanism,
      });
    }
  }
  return citations;
}

export function buildHandles(evidence: PackSynthesisEvidence | undefined): SynthesisHandles {
  const handles: SynthesisHandles = {};
  if (evidence?.retrieve_handle) {
    handles.retrieve_handle = evidence.retrieve_handle;
  }
  return handles;
}

export function createHonestSynthesis(
  goal: string,
  state: ResponseState,
  message: string,
  body: Omit<HonestSynthesisPayload, "goal">,
  extras?: { limitations?: string[]; staleness_hint?: string },
): HonestSynthesis {
  return {
    goal,
    ...body,
    ...stubResponse(state, message, {
      limitations: extras?.limitations,
      staleness_hint: extras?.staleness_hint,
    }),
  };
}

function citationIdSet(citations: SynthesisCitation[]): Set<string> {
  return new Set(citations.map((item) => item.id));
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function asObjectArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null);
}

export function parseLlmStructuredSynthesis(raw: string): {
  known: SynthesisKnown[];
  unknown: SynthesisUnknown[];
} {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  try {
    const parsed = JSON.parse(candidate) as Record<string, unknown>;
    return {
      known: asObjectArray(parsed.known).map((item) => ({
        text: String(item.text ?? "").trim(),
        citation_ids: asStringArray(item.citation_ids),
      })),
      unknown: asObjectArray(parsed.unknown).map((item) => ({
        text: String(item.text ?? "").trim(),
        reason: typeof item.reason === "string" ? item.reason : undefined,
        citation_ids: asStringArray(item.citation_ids),
        handle: typeof item.handle === "string" ? item.handle : undefined,
      })),
    };
  } catch {
    return { known: [], unknown: [] };
  }
}

export function normalizeKnownItems(
  items: SynthesisKnown[],
  citations: SynthesisCitation[],
): { known: SynthesisKnown[]; rejected: SynthesisUnknown[] } {
  const validIds = citationIdSet(citations);
  const known: SynthesisKnown[] = [];
  const rejected: SynthesisUnknown[] = [];
  for (const item of items) {
    const text = item.text.trim();
    if (!text) {
      continue;
    }
    const citation_ids = item.citation_ids.filter((id) => validIds.has(id));
    if (citation_ids.length === 0) {
      rejected.push({ text, reason: "sem_citacao_valida" });
      continue;
    }
    known.push({ text, citation_ids });
  }
  return { known, rejected };
}

export function mergeUnknown(
  base: SynthesisUnknown[],
  extra: SynthesisUnknown[],
): SynthesisUnknown[] {
  const seen = new Set<string>();
  const merged: SynthesisUnknown[] = [];
  for (const item of [...base, ...extra]) {
    const key = `${item.text}|${item.reason ?? ""}|${item.handle ?? ""}`;
    if (seen.has(key) || !item.text.trim()) {
      continue;
    }
    seen.add(key);
    merged.push(item);
  }
  return merged;
}
