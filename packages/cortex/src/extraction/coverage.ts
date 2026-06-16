import { detectLanguageFromPath, getCoverageLevel } from "./language.js";
import type { FileStructuralEntry, LanguageCoverage, SupportedLanguage } from "./types.js";

export function countEligibleByLanguage(manifestPaths: string[]): Record<string, number> {
  const counts: Record<string, number> = {};

  for (const path of manifestPaths) {
    const detection = detectLanguageFromPath(path);
    if (detection.status === "supported") {
      counts[detection.language] = (counts[detection.language] ?? 0) + 1;
    }
  }

  return counts;
}

export function countUnsupportedManifestFiles(manifestPaths: string[]): number {
  return manifestPaths.filter((path) => detectLanguageFromPath(path).status === "unsupported")
    .length;
}

export function buildExtractionLimitations(
  manifestPaths: string[],
  entries: FileStructuralEntry[],
): string[] {
  const limitations: string[] = [];

  const unsupportedCount = countUnsupportedManifestFiles(manifestPaths);
  if (unsupportedCount > 0) {
    limitations.push(
      `${unsupportedCount} arquivo(s) no manifest com extensão não suportada omitidos da extração estrutural.`,
    );
  }

  const parseErrorCount = entries.filter((entry) => entry.parse_errors.length > 0).length;
  if (parseErrorCount > 0) {
    limitations.push(
      `${parseErrorCount} arquivo(s) elegível(is) com erro de parse; símbolos omitidos no escopo desses arquivos.`,
    );
  }

  return limitations;
}

export function buildCoverageSummary(
  files: FileStructuralEntry[],
  manifestPaths: string[],
): Record<string, LanguageCoverage> {
  const eligibleByLanguage = countEligibleByLanguage(manifestPaths);
  const summary: Record<string, LanguageCoverage> = {};

  for (const [language, filesEligible] of Object.entries(eligibleByLanguage)) {
    summary[language] = {
      files_eligible: filesEligible,
      files_parsed: 0,
      symbols: 0,
      coverage_level: getCoverageLevel(language as SupportedLanguage),
    };
  }

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

    if (entry.parse_errors.length === 0) {
      summary[lang].files_parsed += 1;
    }
    summary[lang].symbols += entry.symbols.length;
  }

  return summary;
}
