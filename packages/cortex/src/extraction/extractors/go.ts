import type { SyntaxNode } from "tree-sitter";
import type { FileExtractionResult } from "../types.js";
import { endLine, namedIdentifier, startLine, stripQuotes, walkTree } from "./ast-utils.js";

export function extractGo(root: SyntaxNode): FileExtractionResult {
  const symbols: FileExtractionResult["symbols"] = [];
  const imports: FileExtractionResult["imports"] = [];
  const edges: FileExtractionResult["edges"] = [];

  walkTree(root, (node) => {
    switch (node.type) {
      case "function_declaration":
      case "method_declaration": {
        const name = namedIdentifier(node);
        if (name) {
          symbols.push({
            name,
            kind: "function",
            start_line: startLine(node),
            end_line: endLine(node),
          });
        }
        break;
      }
      case "type_declaration": {
        walkTree(node, (spec) => {
          if (spec.type === "type_spec") {
            const name = namedIdentifier(spec);
            const kind = spec.descendantsOfType("struct_type").length > 0 ? "class" : "type";
            if (name) {
              symbols.push({
                name,
                kind,
                start_line: startLine(spec),
                end_line: endLine(spec),
              });
            }
          }
        });
        break;
      }
      case "import_declaration": {
        walkTree(node, (spec) => {
          if (spec.type === "import_spec") {
            const pathNode = spec.descendantsOfType("interpreted_string_literal")[0];
            if (pathNode) {
              const source = stripQuotes(pathNode.text);
              imports.push({ source });
              edges.push({ kind: "imports", to: source, line: startLine(spec) });
            }
          }
        });
        break;
      }
      case "call_expression": {
        const fn = node.childForFieldName("function");
        if (fn) {
          edges.push({ kind: "calls", to: fn.text, line: startLine(node) });
        }
        break;
      }
      default:
        break;
    }
  });

  return { symbols, imports, edges, parse_errors: [] };
}
