import type { CoverageLevel, SupportedLanguage } from "./types.js";

export type LanguageDetection =
  | { status: "supported"; language: SupportedLanguage; coverage_level: CoverageLevel }
  | { status: "unsupported" };

const EXTENSION_MAP: Record<string, SupportedLanguage> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".pyw": "python",
  ".go": "go",
  ".java": "java",
  ".rs": "rust",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".dart": "dart",
};

const COVERAGE_BY_LANGUAGE: Record<SupportedLanguage, CoverageLevel> = {
  typescript: "full",
  javascript: "full",
  python: "full",
  go: "full",
  java: "full",
  rust: "full",
  kotlin: "partial",
  dart: "full",
};

export function detectLanguageFromPath(relativePath: string): LanguageDetection {
  const dot = relativePath.lastIndexOf(".");
  if (dot === -1) {
    return { status: "unsupported" };
  }

  const ext = relativePath.slice(dot).toLowerCase();
  const language = EXTENSION_MAP[ext];
  if (!language) {
    return { status: "unsupported" };
  }

  return {
    status: "supported",
    language,
    coverage_level: COVERAGE_BY_LANGUAGE[language],
  };
}

export function isSupportedLanguage(language: string): language is SupportedLanguage {
  return language in COVERAGE_BY_LANGUAGE;
}

export function getCoverageLevel(language: SupportedLanguage): CoverageLevel {
  return COVERAGE_BY_LANGUAGE[language];
}

export const SUPPORTED_LANGUAGES = Object.keys(COVERAGE_BY_LANGUAGE) as SupportedLanguage[];
