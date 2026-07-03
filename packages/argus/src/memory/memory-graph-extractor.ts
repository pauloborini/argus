import { createHash } from "node:crypto";
import type { ParsedMarkdown } from "./markdown-parser.js";
import type {
  GraphExtractionContext,
  MemoryGraphEntityDraft,
  MemoryGraphRelationDraft,
  VaultNoteIndexEntry,
} from "./memory-graph-types.js";

const WIKILINK_RE = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
const PATH_CITATION_RE =
  /(?:^|[\s`'"(])([a-zA-Z0-9_@./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|dart|kt|kts|java|go|rs|md|json|yaml|yml))\b/g;
const SYMBOL_BACKTICK_RE = /`([A-Za-z_][A-Za-z0-9_]*)`/g;

function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase();
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+/g, "/");
}

function entityId(kind: string, canonicalKey: string): string {
  return createHash("sha256").update(`${kind}\0${canonicalKey}`).digest("hex").slice(0, 16);
}

export function entityDraftId(entity: MemoryGraphEntityDraft): string {
  return entityId(entity.kind, entity.canonical_key);
}

function resolveVaultNote(
  target: string,
  vaultNotes: GraphExtractionContext["vaultNotes"],
): VaultNoteIndexEntry | undefined {
  const normalized = target.trim().toLowerCase();
  const withoutExt = normalized.replace(/\.md$/i, "");
  return vaultNotes.find((note) => {
    const pathLower = note.path.toLowerCase();
    const titleLower = note.title.toLowerCase();
    const base = pathLower.replace(/\.md$/i, "").split("/").pop() ?? pathLower;
    return (
      pathLower === normalized ||
      pathLower === `${withoutExt}.md` ||
      pathLower.endsWith(`/${withoutExt}.md`) ||
      base === withoutExt ||
      titleLower === normalized
    );
  });
}

function pushUnique(
  relations: MemoryGraphRelationDraft[],
  seen: Set<string>,
  relation: MemoryGraphRelationDraft,
): void {
  const key = `${relation.mechanism}\0${relation.target.kind}\0${relation.target.canonical_key}\0${relation.evidence}`;
  if (seen.has(key)) {
    return;
  }
  seen.add(key);
  relations.push(relation);
}

function extractWikilinks(body: string, ctx: GraphExtractionContext, out: MemoryGraphRelationDraft[], seen: Set<string>): void {
  for (const match of body.matchAll(WIKILINK_RE)) {
    const target = match[1]?.trim() ?? "";
    if (!target) {
      continue;
    }
    const resolved = resolveVaultNote(target, ctx.vaultNotes);
    if (resolved) {
      pushUnique(out, seen, {
        target: { kind: "note", canonical_key: resolved.id, label: resolved.title },
        mechanism: "wikilink",
        confidence: "confirmed",
        evidence: match[0]!,
      });
    } else {
      pushUnique(out, seen, {
        target: { kind: "tag", canonical_key: normalizeTag(target), label: target },
        mechanism: "wikilink",
        confidence: "presumed",
        evidence: match[0]!,
      });
    }
  }
}

function extractFrontmatterLinks(
  links: string[],
  ctx: GraphExtractionContext,
  out: MemoryGraphRelationDraft[],
  seen: Set<string>,
): void {
  for (const link of links) {
    const trimmed = link.trim();
    if (!trimmed) {
      continue;
    }
    const resolved = resolveVaultNote(trimmed, ctx.vaultNotes);
    if (resolved) {
      pushUnique(out, seen, {
        target: { kind: "note", canonical_key: resolved.id, label: resolved.title },
        mechanism: "frontmatter_link",
        confidence: "confirmed",
        evidence: trimmed,
      });
      continue;
    }
    const asPath = normalizePath(trimmed);
    if (ctx.pathExists(asPath)) {
      pushUnique(out, seen, {
        target: { kind: "path", canonical_key: asPath, label: asPath },
        mechanism: "frontmatter_link",
        confidence: "confirmed",
        evidence: trimmed,
      });
      continue;
    }
    pushUnique(out, seen, {
      target: { kind: "tag", canonical_key: normalizeTag(trimmed), label: trimmed },
      mechanism: "frontmatter_link",
      confidence: "presumed",
      evidence: trimmed,
    });
  }
}

function extractTags(tags: string[], out: MemoryGraphRelationDraft[], seen: Set<string>): void {
  for (const tag of tags) {
    const normalized = normalizeTag(tag);
    if (!normalized) {
      continue;
    }
    pushUnique(out, seen, {
      target: { kind: "tag", canonical_key: normalized, label: tag.trim() },
      mechanism: "tag",
      confidence: "confirmed",
      evidence: tag.trim(),
    });
  }
}

function extractPathCitations(
  body: string,
  ctx: GraphExtractionContext,
  out: MemoryGraphRelationDraft[],
  seen: Set<string>,
): void {
  for (const match of body.matchAll(PATH_CITATION_RE)) {
    const raw = match[1]?.trim() ?? "";
    if (!raw) {
      continue;
    }
    const path = normalizePath(raw);
    if (!ctx.pathExists(path)) {
      continue;
    }
    pushUnique(out, seen, {
      target: { kind: "path", canonical_key: path, label: path },
      mechanism: "path_citation",
      confidence: "confirmed",
      evidence: raw,
    });
  }
}

function extractSymbolMentions(
  body: string,
  ctx: GraphExtractionContext,
  out: MemoryGraphRelationDraft[],
  seen: Set<string>,
): void {
  for (const match of body.matchAll(SYMBOL_BACKTICK_RE)) {
    const name = match[1]?.trim() ?? "";
    if (!name || name.length < 2) {
      continue;
    }
    const resolved = ctx.resolveSymbol(name);
    const exact = resolved.find((item) => item.symbol === name) ?? resolved[0];
    if (exact) {
      const key = `${normalizePath(exact.file)}::${exact.symbol}`;
      pushUnique(out, seen, {
        target: { kind: "symbol", canonical_key: key, label: exact.symbol },
        mechanism: "symbol_mention",
        confidence: exact.symbol === name ? "confirmed" : "inferred",
        evidence: match[0]!,
      });
      continue;
    }
    pushUnique(out, seen, {
      target: { kind: "symbol", canonical_key: `unresolved::${name}`, label: name },
      mechanism: "symbol_mention",
      confidence: "presumed",
      evidence: match[0]!,
    });
  }
}

function extractPathOverlap(
  body: string,
  tags: string[],
  ctx: GraphExtractionContext,
  out: MemoryGraphRelationDraft[],
  seen: Set<string>,
): void {
  const corpus = `${body}\n${tags.join(" ")}`.toLowerCase();
  for (const note of ctx.vaultNotes) {
    if (note.id === ctx.noteId) {
      continue;
    }
    const segments = note.path.split("/").filter(Boolean);
    for (const segment of segments) {
      const token = segment.replace(/\.md$/i, "");
      if (token.length < 4) {
        continue;
      }
      if (!corpus.includes(token.toLowerCase())) {
        continue;
      }
      const path = normalizePath(note.path);
      pushUnique(out, seen, {
        target: { kind: "path", canonical_key: path, label: path },
        mechanism: "path_overlap",
        confidence: "inferred",
        evidence: token,
      });
      break;
    }
  }
}

export function extractGraphRelations(parsed: ParsedMarkdown, ctx: GraphExtractionContext): MemoryGraphRelationDraft[] {
  const relations: MemoryGraphRelationDraft[] = [];
  const seen = new Set<string>();
  extractTags(parsed.tags, relations, seen);
  extractFrontmatterLinks(parsed.links, ctx, relations, seen);
  extractWikilinks(parsed.body, ctx, relations, seen);
  extractPathCitations(parsed.body, ctx, relations, seen);
  extractSymbolMentions(parsed.body, ctx, relations, seen);
  extractPathOverlap(parsed.body, parsed.tags, ctx, relations, seen);
  return relations;
}
