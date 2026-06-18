import type { SyntaxNode } from "tree-sitter";
import type { FileExtractionResult } from "../types.js";
import {
  enclosingSymbolName,
  endLine,
  namedIdentifier,
  startLine,
  stripQuotes,
  walkTree,
} from "./ast-utils.js";

// Nós que definem um símbolo dono de uma chamada, p/ atribuir `from_symbol` pela
// subida de ancestral. `variable_declarator` cobre `const f = () => {}`.
const TS_CALL_DEFINERS: ReadonlySet<string> = new Set([
  "function_declaration",
  "generator_function_declaration",
  "method_definition",
  "variable_declarator",
]);

/** `const x = () => {}` / `const x = function(){}` é função, não variável. */
function declaratorIsFunction(declarator: SyntaxNode): boolean {
  const value = declarator.childForFieldName("value");
  const type = value?.type;
  return (
    type === "arrow_function" ||
    type === "function" ||
    type === "function_expression" ||
    type === "generator_function"
  );
}

function isExported(node: SyntaxNode): boolean {
  return node.parent?.type === "export_statement";
}

function extractImport(node: SyntaxNode): { source: string; symbols: string[] } | null {
  const stringNode = node.descendantsOfType("string")[0];
  if (!stringNode) {
    return null;
  }

  const symbols: string[] = [];
  walkTree(node, (child) => {
    if (child.type === "import_specifier" || child.type === "import_clause") {
      const id = namedIdentifier(child);
      if (id) {
        symbols.push(id);
      }
    }
  });

  return { source: stripQuotes(stringNode.text), symbols };
}

export function extractTypeScriptLike(root: SyntaxNode): FileExtractionResult {
  const symbols: FileExtractionResult["symbols"] = [];
  const imports: FileExtractionResult["imports"] = [];
  const edges: FileExtractionResult["edges"] = [];

  walkTree(root, (node) => {
    switch (node.type) {
      case "function_declaration":
      case "method_definition":
      case "generator_function_declaration": {
        const name = namedIdentifier(node);
        if (name) {
          symbols.push({
            name,
            kind: "function",
            start_line: startLine(node),
            end_line: endLine(node),
            exported: isExported(node),
          });
        }
        break;
      }
      case "class_declaration": {
        const name = namedIdentifier(node);
        if (name) {
          symbols.push({
            name,
            kind: "class",
            start_line: startLine(node),
            end_line: endLine(node),
            exported: isExported(node),
          });

          walkTree(node, (child) => {
            if (child.type === "extends_clause") {
              const target = namedIdentifier(child);
              if (target) {
                edges.push({ kind: "extends", from_symbol: name, to: target, line: startLine(child) });
              }
            }
            if (child.type === "implements_clause") {
              walkTree(child, (impl) => {
                if (impl.type === "type_identifier") {
                  edges.push({
                    kind: "implements",
                    from_symbol: name,
                    to: impl.text,
                    line: startLine(impl),
                  });
                }
              });
            }
          });
        }
        break;
      }
      case "interface_declaration": {
        const name = namedIdentifier(node);
        if (name) {
          symbols.push({
            name,
            kind: "interface",
            start_line: startLine(node),
            end_line: endLine(node),
            exported: isExported(node),
          });
        }
        break;
      }
      case "type_alias_declaration": {
        const name = namedIdentifier(node);
        if (name) {
          symbols.push({
            name,
            kind: "type",
            start_line: startLine(node),
            end_line: endLine(node),
            exported: isExported(node),
          });
        }
        break;
      }
      case "enum_declaration": {
        const name = namedIdentifier(node);
        if (name) {
          symbols.push({
            name,
            kind: "enum",
            start_line: startLine(node),
            end_line: endLine(node),
            exported: isExported(node),
          });
        }
        break;
      }
      case "lexical_declaration":
      case "variable_declaration": {
        walkTree(node, (child) => {
          if (child.type === "variable_declarator") {
            const name = namedIdentifier(child);
            if (name) {
              symbols.push({
                name,
                kind: declaratorIsFunction(child) ? "function" : "variable",
                start_line: startLine(child),
                end_line: endLine(child),
                exported: isExported(node),
              });
            }
          }
        });
        break;
      }
      case "import_statement": {
        const extracted = extractImport(node);
        if (extracted) {
          imports.push({
            source: extracted.source,
            symbols: extracted.symbols.length > 0 ? extracted.symbols : undefined,
          });
          edges.push({ kind: "imports", to: extracted.source, line: startLine(node) });
        }
        break;
      }
      case "call_expression": {
        const callee = node.childForFieldName("function") ?? firstChildIdentifier(node);
        if (callee) {
          const from = enclosingSymbolName(node, TS_CALL_DEFINERS);
          edges.push({
            kind: "calls",
            from_symbol: from ?? undefined,
            to: callee.text,
            line: startLine(node),
          });
        }
        break;
      }
      default:
        break;
    }
  });

  return { symbols, imports, edges, parse_errors: [] };
}

function firstChildIdentifier(node: SyntaxNode): SyntaxNode | null {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child && (child.type === "identifier" || child.type === "member_expression")) {
      return child;
    }
  }
  return null;
}
