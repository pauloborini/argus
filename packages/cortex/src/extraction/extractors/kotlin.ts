import type { SyntaxNode } from "tree-sitter";
import type { FileExtractionResult } from "../types.js";
import { endLine, namedIdentifier, startLine, walkTree } from "./ast-utils.js";

export function extractKotlin(root: SyntaxNode): FileExtractionResult {
  const symbols: FileExtractionResult["symbols"] = [];
  const imports: FileExtractionResult["imports"] = [];
  const edges: FileExtractionResult["edges"] = [];

  walkTree(root, (node) => {
    switch (node.type) {
      case "function_declaration": {
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
      case "class_declaration": {
        const name = namedIdentifier(node);
        if (name) {
          symbols.push({
            name,
            kind: "class",
            start_line: startLine(node),
            end_line: endLine(node),
          });

          walkTree(node, (child) => {
            if (child.type === "delegation_specifier" || child.type === "constructor_invocation") {
              const target = child.descendantsOfType("type_identifier")[0]
                ?? child.descendantsOfType("user_type")[0];
              if (target) {
                const typeName = target.descendantsOfType("type_identifier")[0]?.text ?? target.text;
                edges.push({
                  kind: "extends",
                  from_symbol: name,
                  to: typeName,
                  line: startLine(child),
                });
              }
            }
          });
        }
        break;
      }
      case "import_header": {
        const path = node.descendantsOfType("identifier").map((n) => n.text).join(".");
        if (path) {
          imports.push({ source: path });
          edges.push({ kind: "imports", to: path, line: startLine(node) });
        }
        break;
      }
      case "call_expression": {
        const callee = node.childForFieldName("function") ?? namedIdentifier(node);
        if (callee) {
          edges.push({ kind: "calls", to: typeof callee === "string" ? callee : callee.text, line: startLine(node) });
        }
        break;
      }
      default:
        break;
    }
  });

  return { symbols, imports, edges, parse_errors: [] };
}
