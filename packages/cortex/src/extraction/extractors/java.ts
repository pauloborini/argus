import type { SyntaxNode } from "tree-sitter";
import type { FileExtractionResult } from "../types.js";
import { enclosingSymbolName, endLine, namedIdentifier, startLine, walkTree } from "./ast-utils.js";

const JAVA_CALL_DEFINERS: ReadonlySet<string> = new Set([
  "method_declaration",
  "constructor_declaration",
  "compact_constructor_declaration",
]);

export function extractJava(root: SyntaxNode): FileExtractionResult {
  const symbols: FileExtractionResult["symbols"] = [];
  const imports: FileExtractionResult["imports"] = [];
  const edges: FileExtractionResult["edges"] = [];

  walkTree(root, (node) => {
    switch (node.type) {
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
      case "class_declaration":
      case "interface_declaration":
      case "enum_declaration": {
        const name = namedIdentifier(node);
        if (name) {
          const kind =
            node.type === "interface_declaration"
              ? "interface"
              : node.type === "enum_declaration"
                ? "enum"
                : "class";
          symbols.push({
            name,
            kind,
            start_line: startLine(node),
            end_line: endLine(node),
          });

          walkTree(node, (child) => {
            if (child.type === "superclass") {
              const target = child.descendantsOfType("type_identifier")[0]?.text;
              if (target) {
                edges.push({ kind: "extends", from_symbol: name, to: target, line: startLine(child) });
              }
            }
            if (child.type === "super_interfaces") {
              walkTree(child, (iface) => {
                if (iface.type === "type_identifier") {
                  edges.push({
                    kind: "implements",
                    from_symbol: name,
                    to: iface.text,
                    line: startLine(iface),
                  });
                }
              });
            }
          });
        }
        break;
      }
      case "import_declaration": {
        const scoped = node.descendantsOfType("scoped_identifier")[0]?.text
          ?? node.descendantsOfType("identifier")[0]?.text;
        if (scoped) {
          imports.push({ source: scoped });
          edges.push({ kind: "imports", to: scoped, line: startLine(node) });
        }
        break;
      }
      case "method_invocation": {
        const name = node.childForFieldName("name")?.text;
        if (name) {
          const object = node.childForFieldName("object")?.text;
          const from = enclosingSymbolName(node, JAVA_CALL_DEFINERS);
          edges.push({
            kind: "calls",
            from_symbol: from ?? undefined,
            to: object ? `${object}.${name}` : name,
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
