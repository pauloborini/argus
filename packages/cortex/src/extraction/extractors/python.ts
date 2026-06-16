import type { SyntaxNode } from "tree-sitter";
import type { FileExtractionResult } from "../types.js";
import { endLine, namedIdentifier, startLine, walkTree } from "./ast-utils.js";

export function extractPython(root: SyntaxNode): FileExtractionResult {
  const symbols: FileExtractionResult["symbols"] = [];
  const imports: FileExtractionResult["imports"] = [];
  const edges: FileExtractionResult["edges"] = [];

  walkTree(root, (node) => {
    switch (node.type) {
      case "function_definition": {
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
      case "class_definition": {
        const name = namedIdentifier(node);
        if (name) {
          symbols.push({
            name,
            kind: "class",
            start_line: startLine(node),
            end_line: endLine(node),
          });

          walkTree(node, (child) => {
            if (child.type === "argument_list") {
              walkTree(child, (arg) => {
                if (arg.type === "identifier") {
                  edges.push({
                    kind: "extends",
                    from_symbol: name,
                    to: arg.text,
                    line: startLine(arg),
                  });
                }
              });
            }
          });
        }
        break;
      }
      case "import_statement": {
        const moduleName = node.descendantsOfType("dotted_name")[0]?.text;
        if (moduleName) {
          imports.push({ source: moduleName });
          edges.push({ kind: "imports", to: moduleName, line: startLine(node) });
        }
        break;
      }
      case "import_from_statement": {
        const parts = node.descendantsOfType("dotted_name");
        const moduleName = parts[0]?.text;
        const symbol = parts[1]?.text;
        if (moduleName) {
          imports.push({
            source: moduleName,
            symbols: symbol ? [symbol] : undefined,
          });
          edges.push({ kind: "imports", to: moduleName, line: startLine(node) });
        }
        break;
      }
      case "call": {
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
