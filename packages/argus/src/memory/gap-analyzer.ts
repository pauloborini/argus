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
