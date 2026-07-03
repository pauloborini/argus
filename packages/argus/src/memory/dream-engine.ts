import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { dump } from "js-yaml";
import { stubResponse } from "../contracts/response-state.js";
import type { ResponseState } from "../contracts/response-state.js";
import type { ToolResponsePayload } from "../mcp/tools/common.js";
import { loadMemoryConfig } from "./config.js";
import { parseMarkdown, type ParsedMarkdown } from "./markdown-parser.js";
import { getMemoryDbPath, getVaultDir } from "./paths.js";
import { closeMemoryDb, openMemoryDb, type Database } from "./storage/sqlite-db.js";
import { linkSupersedence } from "./v2-contract.js";
import { VaultEngine } from "./vault-engine.js";

export type DreamActionState = "sugerida" | "aplicada" | "bloqueada";
export type DreamActionCategory = "triagem" | "duplicata" | "supersedencia" | "contradicao";

export interface DreamAction {
  category: DreamActionCategory;
  state: DreamActionState;
  sources: string[];
  reason: string;
  score?: number;
  mechanism?: string;
  destination?: string;
}

interface TriagedNote {
  file: string;
  destination: string;
  content: string;
  sourcePath: string;
}

interface LoadedNote {
  path: string;
  absolutePath: string;
  raw: string;
  parsed: ParsedMarkdown;
  tokens: Set<string>;
  noteId: string;
}

interface LoadFailure {
  path: string;
  absolutePath: string;
  error: string;
}

type NoteLoadResult = { ok: true; note: LoadedNote } | { ok: false; failure: LoadFailure };

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function computeNoteId(relPath: string, raw: string): string {
  return hashText(`${relPath}\n${raw}`).slice(0, 16);
}

function tokenizeText(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[\s,.;:!?()"'"`\-+/\\_]+/g).filter((word) => word.length >= 3));
}

function jaccardSimilarity(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const item of left) {
    if (right.has(item)) {
      intersection += 1;
    }
  }
  const union = left.size + right.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function walkMarkdown(dir: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "reports") {
      continue;
    }
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...walkMarkdown(full));
    } else if (entry.endsWith(".md")) {
      out.push(full);
    }
  }
  return out.sort();
}

function classifyNote(parsed: ParsedMarkdown): string | null {
  const haystack = `${parsed.title} ${parsed.body}`.toLowerCase();
  if (parsed.tags.includes("meeting") || parsed.tags.includes("#meeting") || haystack.includes("ata")) {
    return "meetings";
  }
  if (parsed.tags.includes("adr") || parsed.tags.includes("#adr") || haystack.includes("decisão") || haystack.includes("decisao")) {
    return "decisions";
  }
  if (parsed.tags.includes("project") || parsed.tags.includes("#project")) {
    return "projects";
  }
  if (parsed.tags.includes("entity") || parsed.tags.includes("#entity")) {
    return "entities";
  }
  if (parsed.tags.includes("reference") || parsed.tags.includes("#reference") || haystack.includes("referência") || haystack.includes("referencia")) {
    return "references";
  }
  return null;
}

function noteScope(parsed: ParsedMarkdown): string {
  return parsed.scope?.trim() || "project";
}

function safeLoadNote(vaultDir: string, absolutePath: string): NoteLoadResult {
  const rel = relative(vaultDir, absolutePath).replace(/\\/g, "/");
  try {
    const raw = readFileSync(absolutePath, "utf-8");
    const parsed = parseMarkdown(raw, basename(absolutePath));
    return {
      ok: true,
      note: {
        path: rel,
        absolutePath,
        raw,
        parsed,
        tokens: tokenizeText(`${parsed.title} ${parsed.body}`),
        noteId: computeNoteId(rel, raw),
      },
    };
  } catch (err) {
    return {
      ok: false,
      failure: {
        path: rel,
        absolutePath,
        error: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

function mergeFrontmatterFields(raw: string, fields: Record<string, string>): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/m.exec(raw);
  const body = match?.[2] ?? raw;
  const existing = new Map<string, string>();
  if (match?.[1]) {
    for (const line of match[1].split(/\r?\n/)) {
      const parsed = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
      if (parsed) {
        existing.set(parsed[1]!, parsed[2]!.trim().replace(/^["']|["']$/g, ""));
      }
    }
  }
  for (const [key, value] of Object.entries(fields)) {
    existing.set(key, value);
  }
  const frontmatter = [...existing.entries()].map(([key, value]) => `${key}: ${value}`).join("\n");
  return `---\n${frontmatter}\n---\n\n${body.replace(/^\n+/, "")}`;
}

function buildTriagedContent(parsed: ParsedMarkdown, subdir: string): string {
  return [
    "---",
    dump({
      title: parsed.title,
      type: subdir,
      tags: parsed.tags,
      links: parsed.links,
      created_at: parsed.created_at,
      updated_at: new Date().toISOString(),
      ...(parsed.scope ? { scope: parsed.scope } : {}),
      ...(parsed.source ? { source: parsed.source } : {}),
      ...(parsed.confidence ? { confidence: parsed.confidence } : {}),
      ...(parsed.observed_at ? { observed_at: parsed.observed_at } : {}),
      ...(parsed.valid_from ? { valid_from: parsed.valid_from } : {}),
      ...(parsed.valid_until ? { valid_until: parsed.valid_until } : {}),
      ...(parsed.superseded_by ? { superseded_by: parsed.superseded_by } : {}),
      ...(parsed.supersedes ? { supersedes: parsed.supersedes } : {}),
      ...(parsed.stale_reason ? { stale_reason: parsed.stale_reason } : {}),
      ...(parsed.contradiction_reason ? { contradiction_reason: parsed.contradiction_reason } : {}),
      ...(parsed.migrated_from_v1 ? { migrated_from_v1: parsed.migrated_from_v1 } : {}),
    }).trim(),
    "---",
    "",
    parsed.body.trim(),
    "",
  ].join("\n");
}

function pairKey(left: string, right: string): string {
  return left < right ? `${left}\0${right}` : `${right}\0${left}`;
}

interface GraphDuplicate {
  fileA: string;
  fileB: string;
  mechanism: string;
  score: number;
  entityKey?: string;
}

function detectGraphDuplicates(db: Database, pathById: Map<string, string>): GraphDuplicate[] {
  const rows = db
    .prepare(
      `SELECT
         n1.path AS path_a,
         n2.path AS path_b,
         e.canonical_key AS entity_key,
         r1.mechanism AS mechanism,
         r1.confidence AS confidence
       FROM memory_relations r1
       JOIN memory_relations r2
         ON r1.target_entity_id = r2.target_entity_id
        AND r1.source_note_id < r2.source_note_id
       JOIN memory_entities e ON e.id = r1.target_entity_id
       JOIN notes n1 ON n1.id = r1.source_note_id
       JOIN notes n2 ON n2.id = r2.source_note_id
       ORDER BY n1.path, n2.path`,
    )
    .all() as Array<{
    path_a: string;
    path_b: string;
    entity_key: string;
    mechanism: string;
    confidence: string;
  }>;

  const out: GraphDuplicate[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!pathById.has(row.path_a) || !pathById.has(row.path_b)) {
      continue;
    }
    const key = pairKey(row.path_a, row.path_b);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const confidenceScore = row.confidence === "confirmed" ? 1 : row.confidence === "inferred" ? 0.7 : 0.4;
    out.push({
      fileA: row.path_a,
      fileB: row.path_b,
      mechanism: row.mechanism === "path_overlap" ? "path_overlap" : "graph_entity",
      score: confidenceScore,
      entityKey: row.entity_key,
    });
  }
  return out;
}

function hasActiveContradiction(note: LoadedNote): boolean {
  return Boolean(note.parsed.contradiction_reason?.trim());
}

function isSuperseded(note: LoadedNote): boolean {
  return Boolean(note.parsed.superseded_by?.trim());
}

function deriveRunState(blocked: DreamAction[]): ResponseState {
  return blocked.length > 0 ? "parcial" : "sucesso";
}

function reportTimestampSlug(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function writeDreamReport(
  vaultDir: string,
  timestamp: string,
  actions: {
    suggested: DreamAction[];
    applied: DreamAction[];
    blocked: DreamAction[];
  },
  summary: {
    triaged: number;
    duplicates: number;
    supersessions: number;
    contradictions: number;
    dryRun: boolean;
  },
): string {
  const reportsDir = join(vaultDir, "reports");
  mkdirSync(reportsDir, { recursive: true });
  const reportFile = `reports/dream-report-${timestamp}.md`;
  const renderAction = (action: DreamAction): string => {
    const parts = [
      `- **${action.category}** (${action.state})`,
      `  - fontes: ${action.sources.map((source) => `\`${source}\``).join(", ")}`,
      `  - motivo: ${action.reason}`,
    ];
    if (action.score !== undefined) {
      parts.push(`  - score: ${action.score.toFixed(3)}`);
    }
    if (action.mechanism) {
      parts.push(`  - mecanismo: ${action.mechanism}`);
    }
    if (action.destination) {
      parts.push(`  - destino: \`${action.destination}\``);
    }
    return parts.join("\n");
  };
  const renderSection = (items: DreamAction[]): string[] =>
    items.length === 0 ? ["_Nenhum item._", ""] : [...items.map(renderAction), ""];

  const allActions = [...actions.suggested, ...actions.applied, ...actions.blocked];
  const byCategory = (category: DreamActionCategory) => allActions.filter((item) => item.category === category);
  const lines = [
    `# Dream Cycle - ${timestamp}`,
    "",
    `Modo: ${summary.dryRun ? "dry-run" : "apply"}`,
    "",
    "## Resumo",
    "",
    `- Triagem: ${summary.triaged}`,
    `- Duplicatas: ${summary.duplicates}`,
    `- Supersedencia: ${summary.supersessions}`,
    `- Contradicoes: ${summary.contradictions}`,
    `- Sugeridas: ${actions.suggested.length}`,
    `- Aplicadas: ${actions.applied.length}`,
    `- Bloqueadas: ${actions.blocked.length}`,
    "",
    "## Triagem",
    "",
    ...renderSection(byCategory("triagem")),
    "## Duplicatas",
    "",
    ...renderSection(byCategory("duplicata")),
    "## Supersedencia",
    "",
    ...renderSection(byCategory("supersedencia")),
    "## Contradicoes",
    "",
    ...renderSection(byCategory("contradicao")),
    "## Acoes sugeridas",
    "",
    ...renderSection(actions.suggested),
    "## Acoes aplicadas",
    "",
    ...renderSection(actions.applied),
    "## Acoes bloqueadas",
    "",
    ...renderSection(actions.blocked),
  ];
  writeFileSync(join(vaultDir, reportFile), lines.join("\n"), "utf-8");
  return reportFile;
}

export class DreamEngine {
  static async run(
    cwd: string = process.cwd(),
    options: { dryRun?: boolean } = {},
  ): Promise<ToolResponsePayload> {
    const dryRun = options.dryRun ?? false;
    const config = loadMemoryConfig(cwd);
    const vaultDir = getVaultDir(cwd);
    if (!existsSync(vaultDir)) {
      return {
        consolidated: 0,
        suggested_actions: [],
        applied_actions: [],
        blocked_actions: [],
        ...stubResponse("falha", "E_VAULT_NOT_FOUND: execute argus memory init."),
      };
    }

    const maxNotes = config?.dream_max_notes_per_run ?? 50;
    const similarityThreshold = config?.dream_similarity_threshold ?? 0.92;
    const inboxDir = join(vaultDir, "inbox");
    const suggested: DreamAction[] = [];
    const applied: DreamAction[] = [];
    const blocked: DreamAction[] = [];
    const triaged: TriagedNote[] = [];

    if (existsSync(inboxDir)) {
      for (const file of readdirSync(inboxDir).filter((item) => item.endsWith(".md")).slice(0, maxNotes)) {
        const sourcePath = join(inboxDir, file);
        const loaded = safeLoadNote(vaultDir, sourcePath);
        if (!loaded.ok) {
          blocked.push({
            category: "triagem",
            state: "bloqueada",
            sources: [loaded.failure.path],
            reason: `arquivo_ilegivel: ${loaded.failure.error}`,
          });
          continue;
        }
        const subdir = classifyNote(loaded.note.parsed);
        if (!subdir) {
          blocked.push({
            category: "triagem",
            state: "bloqueada",
            sources: [loaded.note.path],
            reason: "classificacao_indeterminada",
          });
          continue;
        }
        const destination = `${subdir}/${file}`;
        const action: DreamAction = {
          category: "triagem",
          state: dryRun ? "sugerida" : "aplicada",
          sources: [loaded.note.path],
          reason: dryRun ? "triagem candidata para revisao" : "triagem aplicada",
          destination,
        };
        if (dryRun) {
          suggested.push(action);
        } else {
          applied.push(action);
        }
        triaged.push({
          file: loaded.note.path,
          destination,
          content: buildTriagedContent(loaded.note.parsed, subdir),
          sourcePath,
        });
      }
    }

    if (!dryRun) {
      for (const note of triaged) {
        const target = join(vaultDir, note.destination);
        mkdirSync(join(vaultDir, note.destination.split("/")[0]!), { recursive: true });
        writeFileSync(target, note.content, "utf-8");
        unlinkSync(note.sourcePath);
      }
    }

    const noteFiles = walkMarkdown(vaultDir);
    const loadedNotes: LoadedNote[] = [];
    for (const file of noteFiles) {
      const loaded = safeLoadNote(vaultDir, file);
      if (!loaded.ok) {
        blocked.push({
          category: "triagem",
          state: "bloqueada",
          sources: [loaded.failure.path],
          reason: `arquivo_ilegivel: ${loaded.failure.error}`,
        });
        continue;
      }
      loadedNotes.push(loaded.note);
    }

    const notesByPath = new Map(loadedNotes.map((note) => [note.path, note]));
    const notesById = new Map(loadedNotes.map((note) => [note.noteId, note]));

    for (const note of loadedNotes) {
      if (hasActiveContradiction(note)) {
        blocked.push({
          category: "contradicao",
          state: "bloqueada",
          sources: [note.path],
          reason: note.parsed.contradiction_reason!.trim(),
        });
      }
    }

    const lexicalDuplicates: Array<{ fileA: string; fileB: string; score: number }> = [];
    for (let i = 0; i < loadedNotes.length; i += 1) {
      for (let j = i + 1; j < loadedNotes.length; j += 1) {
        const left = loadedNotes[i]!;
        const right = loadedNotes[j]!;
        const score = jaccardSimilarity(left.tokens, right.tokens);
        if (score > similarityThreshold) {
          lexicalDuplicates.push({ fileA: left.path, fileB: right.path, score });
        }
      }
    }

    let graphDuplicates: GraphDuplicate[] = [];
    if (existsSync(getMemoryDbPath(cwd))) {
      const db = openMemoryDb(cwd, { readonly: true });
      try {
        graphDuplicates = detectGraphDuplicates(db, new Map(loadedNotes.map((note) => [note.path, note.path])));
      } finally {
        closeMemoryDb(db);
      }
    }

    const duplicatePairs = new Map<string, DreamAction>();
    for (const dup of lexicalDuplicates) {
      const key = pairKey(dup.fileA, dup.fileB);
      duplicatePairs.set(key, {
        category: "duplicata",
        state: "sugerida",
        sources: [dup.fileA, dup.fileB],
        reason: "similaridade lexical acima do limiar",
        score: dup.score,
        mechanism: "lexical",
      });
    }
    for (const dup of graphDuplicates) {
      const key = pairKey(dup.fileA, dup.fileB);
      if (!duplicatePairs.has(key)) {
        duplicatePairs.set(key, {
          category: "duplicata",
          state: "sugerida",
          sources: [dup.fileA, dup.fileB],
          reason: dup.entityKey ? `mesma entidade: ${dup.entityKey}` : "relacao no grafo local",
          score: dup.score,
          mechanism: dup.mechanism,
        });
      }
    }
    for (const action of duplicatePairs.values()) {
      suggested.push(action);
    }

    const supersessionCandidates: Array<{ origin: LoadedNote; current: LoadedNote; score: number; reason: string }> =
      [];
    for (let i = 0; i < loadedNotes.length; i += 1) {
      for (let j = i + 1; j < loadedNotes.length; j += 1) {
        const left = loadedNotes[i]!;
        const right = loadedNotes[j]!;
        if (noteScope(left.parsed) !== noteScope(right.parsed)) {
          continue;
        }
        if (hasActiveContradiction(left) || hasActiveContradiction(right)) {
          continue;
        }
        const bodyScore = jaccardSimilarity(
          tokenizeText(left.parsed.body),
          tokenizeText(right.parsed.body),
        );
        const leftSupersedes = left.parsed.supersedes?.trim();
        const rightSupersedes = right.parsed.supersedes?.trim();
        if (leftSupersedes === right.noteId || right.parsed.superseded_by?.trim() === left.noteId) {
          supersessionCandidates.push({
            origin: right,
            current: left,
            score: 1,
            reason: "referencia explicita superseded_by/supersedes",
          });
          continue;
        }
        if (rightSupersedes === left.noteId || left.parsed.superseded_by?.trim() === right.noteId) {
          supersessionCandidates.push({
            origin: left,
            current: right,
            score: 1,
            reason: "referencia explicita superseded_by/supersedes",
          });
          continue;
        }
        if (bodyScore > similarityThreshold && !isSuperseded(left) && !isSuperseded(right)) {
          const leftTime = left.parsed.updated_at ?? left.parsed.created_at ?? "";
          const rightTime = right.parsed.updated_at ?? right.parsed.created_at ?? "";
          let origin: LoadedNote;
          let current: LoadedNote;
          if (leftTime && rightTime && leftTime !== rightTime) {
            origin = leftTime < rightTime ? left : right;
            current = origin === left ? right : left;
          } else {
            origin = left.path < right.path ? left : right;
            current = origin === left ? right : left;
          }
          supersessionCandidates.push({
            origin,
            current,
            score: bodyScore,
            reason: "mesmo escopo com alta similaridade lexical",
          });
        }
      }
    }

    const appliedSupersedence = new Set<string>();
    const supersedenceTouchedNotes = new Set<string>();
    for (const candidate of supersessionCandidates) {
      if (isSuperseded(candidate.origin) || candidate.origin.parsed.supersedes?.trim()) {
        suggested.push({
          category: "supersedencia",
          state: "sugerida",
          sources: [candidate.origin.path, candidate.current.path],
          reason: "supersedencia ja parcialmente registrada",
          score: candidate.score,
          mechanism: "v2",
        });
        continue;
      }
      const link = linkSupersedence(candidate.origin.noteId, candidate.current.noteId);
      if (!link.ok) {
        blocked.push({
          category: "supersedencia",
          state: "bloqueada",
          sources: [candidate.origin.path, candidate.current.path],
          reason: link.message,
          score: candidate.score,
          mechanism: "v2",
        });
        continue;
      }
      const pairId = pairKey(candidate.origin.path, candidate.current.path);
      if (appliedSupersedence.has(pairId)) {
        continue;
      }
      if (dryRun) {
        suggested.push({
          category: "supersedencia",
          state: "sugerida",
          sources: [candidate.origin.path, candidate.current.path],
          reason: candidate.reason,
          score: candidate.score,
          mechanism: "v2",
        });
        continue;
      }

      const currentOriginLoad = safeLoadNote(vaultDir, candidate.origin.absolutePath);
      const currentNoteLoad = safeLoadNote(vaultDir, candidate.current.absolutePath);
      if (!currentOriginLoad.ok || !currentNoteLoad.ok) {
        blocked.push({
          category: "supersedencia",
          state: "bloqueada",
          sources: [candidate.origin.path, candidate.current.path],
          reason: "arquivo_ilegivel_ao_revalidar_supersedencia",
          score: candidate.score,
          mechanism: "v2",
        });
        continue;
      }
      const currentOrigin = currentOriginLoad.note;
      const currentNote = currentNoteLoad.note;
      if (
        supersedenceTouchedNotes.has(currentOrigin.path) ||
        supersedenceTouchedNotes.has(currentNote.path) ||
        isSuperseded(currentOrigin) ||
        isSuperseded(currentNote) ||
        currentOrigin.parsed.supersedes?.trim() ||
        currentNote.parsed.supersedes?.trim()
      ) {
        suggested.push({
          category: "supersedencia",
          state: "sugerida",
          sources: [currentOrigin.path, currentNote.path],
          reason: "supersedencia em grupo requer revisao para evitar refs inconsistentes",
          score: candidate.score,
          mechanism: "v2",
        });
        continue;
      }

      const refreshedLink = linkSupersedence(currentOrigin.noteId, currentNote.noteId);
      if (!refreshedLink.ok) {
        blocked.push({
          category: "supersedencia",
          state: "bloqueada",
          sources: [currentOrigin.path, currentNote.path],
          reason: refreshedLink.message,
          score: candidate.score,
          mechanism: "v2",
        });
        continue;
      }
      const originRaw = mergeFrontmatterFields(currentOrigin.raw, {
        superseded_by: refreshedLink.origin.superseded_by!,
      });
      const currentRaw = mergeFrontmatterFields(currentNote.raw, {
        supersedes: refreshedLink.current.supersedes!,
      });
      writeFileSync(currentOrigin.absolutePath, originRaw, "utf-8");
      writeFileSync(currentNote.absolutePath, currentRaw, "utf-8");
      appliedSupersedence.add(pairId);
      supersedenceTouchedNotes.add(currentOrigin.path);
      supersedenceTouchedNotes.add(currentNote.path);
      applied.push({
        category: "supersedencia",
        state: "aplicada",
        sources: [currentOrigin.path, currentNote.path],
        reason: candidate.reason,
        score: candidate.score,
        mechanism: "v2",
      });
      const refreshedOrigin = safeLoadNote(vaultDir, currentOrigin.absolutePath);
      const refreshedCurrent = safeLoadNote(vaultDir, currentNote.absolutePath);
      if (refreshedOrigin.ok) {
        notesByPath.set(refreshedOrigin.note.path, refreshedOrigin.note);
        notesById.set(refreshedOrigin.note.noteId, refreshedOrigin.note);
      }
      if (refreshedCurrent.ok) {
        notesByPath.set(refreshedCurrent.note.path, refreshedCurrent.note);
        notesById.set(refreshedCurrent.note.noteId, refreshedCurrent.note);
      }
    }

    if (!dryRun && (triaged.length > 0 || appliedSupersedence.size > 0)) {
      VaultEngine.sync(cwd);
    }

    const timestamp = reportTimestampSlug();
    const reportFile = writeDreamReport(
      vaultDir,
      timestamp,
      { suggested, applied, blocked },
      {
        triaged: triaged.length,
        duplicates: duplicatePairs.size,
        supersessions: [...applied, ...suggested].filter((item) => item.category === "supersedencia").length,
        contradictions: blocked.filter((item) => item.category === "contradicao").length,
        dryRun,
      },
    );

    const runState = deriveRunState(blocked);
    const message = dryRun
      ? runState === "parcial"
        ? "Dream dry-run concluído com bloqueios localizados."
        : "Dream dry-run concluído."
      : runState === "parcial"
        ? "Dream concluído com bloqueios localizados."
        : "Dream concluído.";

    return {
      consolidated: applied.filter((item) => item.category === "triagem").length,
      triaged_count: triaged.length,
      duplicates_detected: duplicatePairs.size,
      triaged_notes: triaged.map((note) => ({ file: note.file, destination: note.destination })),
      suggested_actions: suggested,
      applied_actions: applied,
      blocked_actions: blocked,
      report_file: reportFile,
      ...stubResponse(runState, message),
    };
  }
}
