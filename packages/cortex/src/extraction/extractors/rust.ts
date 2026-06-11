import type { SyntaxNode } from "tree-sitter";
import type { FileExtractionResult } from "../types.js";
import { endLine, namedIdentifier, startLine, walkTree } from "./ast-utils.js";

export function extractRust(root: SyntaxNode): FileExtractionResult {
  const symbols: FileExtractionResult["symbols"] = [];
  const imports: FileExtractionResult["imports"] = [];
  const edges: FileExtractionResult["edges"] = [];

  walkTree(root, (node) => {
    switch (node.type) {
      case "function_item": {
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
      case "struct_item":
      case "enum_item":
      case "trait_item":
      case "type_item": {
        const name = namedIdentifier(node);
        if (name) {
          const kind =
            node.type === "enum_item"
              ? "enum"
              : node.type === "trait_item"
                ? "interface"
                : node.type === "type_item"
                  ? "type"
                  : "class";
          symbols.push({
            name,
            kind,
            start_line: startLine(node),
            end_line: endLine(node),
          });
        }
        break;
      }
      case "use_declaration": {
        const path = node.descendantsOfType("scoped_identifier")[0]?.text
          ?? node.descendantsOfType("identifier")[0]?.text;
        if (path) {
          imports.push({ source: path });
          edges.push({ kind: "imports", to: path, line: startLine(node) });
        }
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
