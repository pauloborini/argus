import type { SyntaxNode } from "tree-sitter";
import type { FileExtractionResult } from "../types.js";
import { enclosingSymbolName, endLine, namedIdentifier, startLine, walkTree } from "./ast-utils.js";

const PY_CALL_DEFINERS: ReadonlySet<string> = new Set(["function_definition"]);

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

          // Superclasses = argumentos **posicionais** diretos da argument_list.
          // Antes, o walk recursivo capturava também `metaclass=M` (valor do
          // keyword_argument), `Generic[T]` (subscript) e args de keyword como se
          // fossem superclasses — ruído. Aqui só identifier/attribute diretos.
          const argList = node.childForFieldName("superclasses")
            ?? node.descendantsOfType("argument_list")[0];
          if (argList) {
            for (let i = 0; i < argList.namedChildCount; i += 1) {
              const arg = argList.namedChild(i);
              if (arg && (arg.type === "identifier" || arg.type === "attribute")) {
                edges.push({
                  kind: "extends",
                  from_symbol: name,
                  to: arg.text,
                  line: startLine(arg),
                });
              }
            }
          }
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
          const from = enclosingSymbolName(node, PY_CALL_DEFINERS);
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
