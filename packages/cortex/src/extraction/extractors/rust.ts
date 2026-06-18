import type { SyntaxNode } from "tree-sitter";
import type { FileExtractionResult } from "../types.js";
import { enclosingSymbolName, endLine, namedIdentifier, startLine, walkTree } from "./ast-utils.js";

const RUST_CALL_DEFINERS: ReadonlySet<string> = new Set(["function_item"]);

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
      case "impl_item": {
        // `impl Trait for Type` → relação de subtipo (Type implements Trait),
        // útil p/ impact/trace. `impl Type {}` (sem trait) só agrupa métodos —
        // os function_item internos já são capturados pelo walk recursivo.
        const typeNode = node.childForFieldName("type");
        const traitNode = node.childForFieldName("trait");
        const typeName = typeNode
          ? (typeNode.descendantsOfType("type_identifier")[0]?.text ?? typeNode.text)
          : null;
        if (typeName && traitNode) {
          const traitName = traitNode.descendantsOfType("type_identifier")[0]?.text ?? traitNode.text;
          edges.push({
            kind: "implements",
            from_symbol: typeName,
            to: traitName,
            line: startLine(node),
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
          const from = enclosingSymbolName(node, RUST_CALL_DEFINERS);
          edges.push({
            kind: "calls",
            from_symbol: from ?? undefined,
            to: fn.text,
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
