import { detectLanguageFromPath, getCoverageLevel } from "./language.js";
import type { FileStructuralEntry, LanguageCoverage, SupportedLanguage } from "./types.js";

export function buildCoverageSummary(files: FileStructuralEntry[]): Record<string, LanguageCoverage> {
  const summary: Record<string, LanguageCoverage> = {};

  for (const entry of files) {
    if (entry.language === "unsupported") {
      continue;
    }

    const lang = entry.language;
    if (!summary[lang]) {
      summary[lang] = {
        files_eligible: 0,
        files_parsed: 0,
        symbols: 0,
        coverage_level: getCoverageLevel(lang),
      };
    }

    summary[lang].files_eligible += 1;
    if (entry.parse_errors.length === 0) {
      summary[lang].files_parsed += 1;
    }
    summary[lang].symbols += entry.symbols.length;
  }

  return summary;
}

export function countEligibleByLanguage(manifestPaths: string[]): Record<SupportedLanguage, number> {
  const counts = {} as Record<SupportedLanguage, number>;

  for (const path of manifestPaths) {
    const detection = detectLanguageFromPath(path);
    if (detection.status === "supported") {
      counts[detection.language] = (counts[detection.language] ?? 0) + 1;
    }
  }

  return counts;
}
