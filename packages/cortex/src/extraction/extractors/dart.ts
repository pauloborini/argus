import type { SyntaxNode } from "tree-sitter";
import type { FileExtractionResult } from "../types.js";
import { endLine, namedIdentifier, startLine, stripQuotes, walkTree } from "./ast-utils.js";

export function extractDart(root: SyntaxNode): FileExtractionResult {
  const symbols: FileExtractionResult["symbols"] = [];
  const imports: FileExtractionResult["imports"] = [];
  const edges: FileExtractionResult["edges"] = [];

  walkTree(root, (node) => {
    switch (node.type) {
      case "function_signature":
      case "method_signature":
      case "getter_signature":
      case "setter_signature": {
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
      case "class_definition":
      case "enum_declaration":
      case "extension_declaration": {
        const name = namedIdentifier(node);
        if (name) {
          const kind = node.type === "enum_declaration" ? "enum" : "class";
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
            if (child.type === "interfaces") {
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
      case "library_import": {
        const spec = node.descendantsOfType("import_specification")[0];
        const uri = spec?.descendantsOfType("configuration_uri")[0]?.text
          ?? spec?.descendantsOfType("identifier")[0]?.text;
        if (uri) {
          const source = stripQuotes(uri);
          imports.push({ source });
          edges.push({ kind: "imports", to: source, line: startLine(node) });
        }
        break;
      }
      default:
        break;
    }
  });

  return { symbols, imports, edges, parse_errors: [] };
}
