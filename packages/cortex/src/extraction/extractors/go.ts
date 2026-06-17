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

const GO_CALL_DEFINERS: ReadonlySet<string> = new Set([
  "function_declaration",
  "method_declaration",
]);

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
            const kind =
              spec.descendantsOfType("interface_type").length > 0
                ? "interface"
                : spec.descendantsOfType("struct_type").length > 0
                  ? "class"
                  : "type";
            if (name) {
              symbols.push({
                name,
                kind,
                start_line: startLine(spec),
                end_line: endLine(spec),
              });

              // Embedding Go = composição com promoção de métodos (a herança
              // do Go). Struct: field_declaration sem field_identifier (campo
              // anônimo). Interface: qualified_type embutido (`io.Reader`).
              // Modelado como extends p/ impact/trace cruzar o tipo embutido.
              if (kind === "class") {
                const fields = spec
                  .descendantsOfType("struct_type")[0]
                  ?.descendantsOfType("field_declaration") ?? [];
                for (const field of fields) {
                  if (field.descendantsOfType("field_identifier").length > 0) {
                    continue;
                  }
                  const embedded =
                    field.descendantsOfType("qualified_type")[0]?.text ??
                    field.descendantsOfType("type_identifier").at(-1)?.text;
                  if (embedded) {
                    edges.push({
                      kind: "extends",
                      from_symbol: name,
                      to: embedded.split(".").at(-1) ?? embedded,
                      line: startLine(field),
                    });
                  }
                }
              } else if (kind === "interface") {
                const embeds =
                  spec.descendantsOfType("interface_type")[0]?.descendantsOfType("qualified_type") ??
                  [];
                for (const embed of embeds) {
                  const target = embed.descendantsOfType("type_identifier").at(-1)?.text ?? embed.text;
                  edges.push({
                    kind: "extends",
                    from_symbol: name,
                    to: target,
                    line: startLine(embed),
                  });
                }
              }
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
          const from = enclosingSymbolName(node, GO_CALL_DEFINERS);
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
