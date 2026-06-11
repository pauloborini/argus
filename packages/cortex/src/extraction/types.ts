/** Tipos do índice estrutural (S05) */

export const STRUCTURAL_INDEX_SCHEMA_VERSION = "1.0.0";

export type SymbolKind =
  | "function"
  | "class"
  | "interface"
  | "type"
  | "variable"
  | "enum"
  | "module";

export type EdgeKind = "imports" | "extends" | "implements" | "calls" | "references";

export type CoverageLevel = "full" | "partial" | "unsupported";

export type SupportedLanguage =
  | "typescript"
  | "javascript"
  | "python"
  | "go"
  | "java"
  | "rust"
  | "kotlin"
  | "dart";

export interface ExtractedSymbol {
  name: string;
  kind: SymbolKind;
  start_line: number;
  end_line: number;
  exported?: boolean;
}

export interface ExtractedImport {
  source: string;
  symbols?: string[];
  resolved_path?: string;
}

export interface ExtractedEdge {
  kind: EdgeKind;
  from_symbol?: string;
  to: string;
  line?: number;
}

export interface ParseError {
  message: string;
  line?: number;
}

export interface FileStructuralEntry {
  relative_path: string;
  language: SupportedLanguage | "unsupported";
  symbols: ExtractedSymbol[];
  imports: ExtractedImport[];
  edges: ExtractedEdge[];
  parse_errors: ParseError[];
}

export interface LanguageCoverage {
  files_eligible: number;
  files_parsed: number;
  symbols: number;
  coverage_level: CoverageLevel;
}

export interface StructuralIndex {
  schema_version: string;
  generated_at: string;
  manifest_hash: string;
  file_count: number;
  symbol_count: number;
  files: FileStructuralEntry[];
  coverage_by_language: Record<string, LanguageCoverage>;
}

export interface FileExtractionResult {
  symbols: ExtractedSymbol[];
  imports: ExtractedImport[];
  edges: ExtractedEdge[];
  parse_errors: ParseError[];
}
