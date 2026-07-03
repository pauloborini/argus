export interface ParsedMarkdown {
  title: string;
  type: string;
  tags: string[];
  links: string[];
  created_at?: string;
  updated_at?: string;
  scope?: string;
  source?: string;
  confidence?: string;
  observed_at?: string;
  valid_from?: string;
  valid_until?: string;
  superseded_by?: string;
  supersedes?: string;
  stale_reason?: string;
  contradiction_reason?: string;
  migrated_from_v1?: string;
  body: string;
}

function parseList(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  const trimmed = value.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed
      .slice(1, -1)
      .split(",")
      .map((item) => item.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
  }
  return trimmed
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function parseMarkdown(content: string, fallbackTitle: string): ParsedMarkdown {
  let body = content;
  const meta = new Map<string, string>();
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/m.exec(content);
  if (frontmatter) {
    body = frontmatter[2] ?? "";
    for (const line of (frontmatter[1] ?? "").split(/\r?\n/)) {
      const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
      if (match) {
        meta.set(match[1]!.trim(), match[2]!.trim().replace(/^["']|["']$/g, ""));
      }
    }
  }
  const heading = /^#\s+(.+)$/m.exec(body);
  const title = meta.get("title") || heading?.[1]?.trim() || fallbackTitle;
  return {
    title,
    type: meta.get("type") || "inbox",
    tags: parseList(meta.get("tags")),
    links: parseList(meta.get("links")),
    created_at: meta.get("created_at"),
    updated_at: meta.get("updated_at"),
    scope: meta.get("scope"),
    source: meta.get("source"),
    confidence: meta.get("confidence"),
    observed_at: meta.get("observed_at"),
    valid_from: meta.get("valid_from"),
    valid_until: meta.get("valid_until"),
    superseded_by: meta.get("superseded_by"),
    supersedes: meta.get("supersedes"),
    stale_reason: meta.get("stale_reason"),
    contradiction_reason: meta.get("contradiction_reason"),
    migrated_from_v1: meta.get("migrated_from_v1"),
    body,
  };
}

