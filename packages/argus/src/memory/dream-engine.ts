import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { dump } from "js-yaml";
import { stubResponse } from "../contracts/response-state.js";
import type { ToolResponsePayload } from "../mcp/tools/common.js";
import { loadMemoryConfig } from "./config.js";
import { parseMarkdown } from "./markdown-parser.js";
import { getVaultDir } from "./paths.js";
import { VaultEngine } from "./vault-engine.js";

interface TriagedNote {
  file: string;
  destination: string;
  content: string;
  sourcePath: string;
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

function classifyNote(parsed: ReturnType<typeof parseMarkdown>): string | null {
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

export class DreamEngine {
  static async run(
    cwd: string = process.cwd(),
    options: { dryRun?: boolean } = {},
  ): Promise<ToolResponsePayload> {
    const config = loadMemoryConfig(cwd);
    const vaultDir = getVaultDir(cwd);
    if (!existsSync(vaultDir)) {
      return { consolidated: 0, ...stubResponse("falha", "E_VAULT_NOT_FOUND: execute argus memory init.") };
    }

    const maxNotes = config?.dream_max_notes_per_run ?? 50;
    const similarityThreshold = config?.dream_similarity_threshold ?? 0.92;
    const inboxDir = join(vaultDir, "inbox");
    const triaged: TriagedNote[] = [];

    if (existsSync(inboxDir)) {
      for (const file of readdirSync(inboxDir).filter((item) => item.endsWith(".md")).slice(0, maxNotes)) {
        const sourcePath = join(inboxDir, file);
        const raw = readFileSync(sourcePath, "utf-8");
        const parsed = parseMarkdown(raw, file);
        const subdir = classifyNote(parsed);
        if (!subdir) {
          continue;
        }
        const content = [
          "---",
          dump({
            title: parsed.title,
            type: subdir,
            tags: parsed.tags,
            links: parsed.links,
            created_at: parsed.created_at,
            updated_at: new Date().toISOString(),
          }).trim(),
          "---",
          "",
          parsed.body.trim(),
          "",
        ].join("\n");
        triaged.push({ file: `inbox/${file}`, destination: `${subdir}/${file}`, content, sourcePath });
      }
    }

    if (!options.dryRun) {
      for (const note of triaged) {
        const target = join(vaultDir, note.destination);
        mkdirSync(join(vaultDir, note.destination.split("/")[0]!), { recursive: true });
        writeFileSync(target, note.content, "utf-8");
        unlinkSync(note.sourcePath);
      }
      if (triaged.length > 0) {
        VaultEngine.sync(cwd);
      }
    }

    const notes = walkMarkdown(vaultDir).map((file) => {
      const raw = readFileSync(file, "utf-8");
      const parsed = parseMarkdown(raw, basename(file));
      return {
        path: relative(vaultDir, file),
        title: parsed.title,
        tokens: tokenizeText(`${parsed.title} ${parsed.body}`),
      };
    });
    const duplicates: Array<{ fileA: string; fileB: string; score: number }> = [];
    for (let i = 0; i < notes.length; i += 1) {
      for (let j = i + 1; j < notes.length; j += 1) {
        const score = jaccardSimilarity(notes[i]!.tokens, notes[j]!.tokens);
        if (score > similarityThreshold) {
          duplicates.push({ fileA: notes[i]!.path, fileB: notes[j]!.path, score });
        }
      }
    }

    let reportFile: string | undefined;
    if (!options.dryRun) {
      const reportsDir = join(vaultDir, "reports");
      mkdirSync(reportsDir, { recursive: true });
      const date = new Date().toISOString().slice(0, 10);
      reportFile = `reports/dream-report-${date}.md`;
      const lines = [
        `# Dream Cycle - ${date}`,
        "",
        `Triaged: ${triaged.length}`,
        `Duplicates: ${duplicates.length}`,
        "",
        ...duplicates.map((dup) => `- ${basename(dup.fileA)} <> ${basename(dup.fileB)} (${dup.score.toFixed(3)})`),
        "",
      ];
      writeFileSync(join(vaultDir, reportFile), lines.join("\n"), "utf-8");
    }

    return {
      consolidated: triaged.length,
      triaged_count: triaged.length,
      duplicates_detected: duplicates.length,
      triaged_notes: triaged.map((note) => ({ file: note.file, destination: note.destination })),
      report_file: reportFile,
      ...stubResponse("sucesso", options.dryRun ? "Dream dry-run concluído." : "Dream concluído."),
    };
  }
}
