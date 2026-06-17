import type { SyntaxNode } from "tree-sitter";
import type { FileExtractionResult } from "../types.js";
import { endLine, namedIdentifier, startLine, stripQuotes, walkTree } from "./ast-utils.js";

/**
 * Nome de um signature Dart. A grammar coloca o tipo de retorno como
 * `type_identifier` **antes** do nome, então `namedIdentifier` (que pega o
 * primeiro identifier-like) devolveria o tipo (`int`) em vez de `load`.
 * Aqui preferimos o field `name` (presente em function/getter/setter_signature)
 * e só caímos para o primeiro identifier que **não** seja `type_identifier`.
 * `method_signature` não tem field nem identifier direto (envolve um
 * `function_signature`), então devolve null e o filho aninhado registra o nome.
 */
function dartSymbolName(node: SyntaxNode): string | null {
  const field = node.childForFieldName("name");
  if (field) {
    return field.text;
  }
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (
      child &&
      (child.type === "identifier" ||
        child.type === "simple_identifier" ||
        child.type === "property_identifier")
    ) {
      return child.text;
    }
  }
  return null;
}

/**
 * Símbolo que encerra um call Dart. O corpo de um método/função é um
 * `function_body` **irmão** do signature (não ancestral), então a subida
 * genérica de `enclosingSymbolName` não acha o dono. Aqui subimos até o
 * `function_body` e pegamos o nome do signature irmão anterior (descendo no
 * `function_signature` aninhado de métodos).
 */
function dartEnclosingSymbol(node: SyntaxNode): string | undefined {
  let current: SyntaxNode | null = node;
  while (current) {
    if (current.type === "function_body") {
      const sig = current.previousNamedSibling;
      if (sig) {
        const fnSig =
          sig.type === "function_signature"
            ? sig
            : sig.descendantsOfType("function_signature")[0] ?? sig;
        const name = dartSymbolName(fnSig);
        if (name) {
          return name;
        }
      }
    }
    current = current.parent;
  }
  return undefined;
}

/**
 * Resolve o callee a partir do `argument_part` (que ancora toda invocação,
 * inclusive sem argumentos). O pai é o `selector` de argumentos; o irmão
 * anterior é ou um `identifier` simples (`helper()`) ou outro `selector` de
 * acesso (`obj.method()` → último identifier de `.method`).
 */
function dartCallee(argumentPart: SyntaxNode): string | undefined {
  const selector = argumentPart.parent;
  const prev = selector?.previousNamedSibling;
  if (!prev) {
    return undefined;
  }
  if (prev.type === "identifier" || prev.type === "simple_identifier") {
    return prev.text;
  }
  if (prev.type === "selector") {
    const method = prev.descendantsOfType("identifier").at(-1)?.text;
    if (!method) {
      return undefined;
    }
    const receiver = prev.previousNamedSibling?.text;
    return receiver ? `${receiver}.${method}` : method;
  }
  return undefined;
}

function extractDartImportSource(spec: SyntaxNode): string | null {
  const uri =
    spec.descendantsOfType("uri")[0]?.text ??
    spec.descendantsOfType("configurable_uri")[0]?.descendantsOfType("uri")[0]?.text ??
    spec.descendantsOfType("configuration_uri")[0]?.descendantsOfType("uri")[0]?.text ??
    spec.descendantsOfType("identifier")[0]?.text;
  return uri ? stripQuotes(uri) : null;
}

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
        const name = dartSymbolName(node);
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
      case "extension_declaration":
      case "mixin_declaration": {
        const name = namedIdentifier(node);
        if (name) {
          const kind = node.type === "enum_declaration" ? "enum" : "class";
          symbols.push({
            name,
            kind,
            start_line: startLine(node),
            end_line: endLine(node),
          });

          // Restrição `on` de mixin (`mixin M on Base`): o tipo requerido é um
          // type_identifier filho direto do mixin_declaration. Modelado como
          // extends para fins de impacto/trace (mudar Base afeta M).
          if (node.type === "mixin_declaration") {
            for (let i = 0; i < node.childCount; i++) {
              const child = node.child(i);
              if (child?.type === "type_identifier") {
                edges.push({ kind: "extends", from_symbol: name, to: child.text, line: startLine(child) });
              }
            }
          }

          walkTree(node, (child) => {
            if (child.type === "superclass") {
              const target = child.descendantsOfType("type_identifier")[0]?.text;
              if (target) {
                edges.push({ kind: "extends", from_symbol: name, to: target, line: startLine(child) });
              }
            }
            // Aplicação de mixin (`class X with M`): em Dart cria relação de
            // subtipo, então modelamos como implements para impact/trace.
            if (child.type === "mixins") {
              walkTree(child, (mixin) => {
                if (mixin.type === "type_identifier") {
                  edges.push({
                    kind: "implements",
                    from_symbol: name,
                    to: mixin.text,
                    line: startLine(mixin),
                  });
                }
              });
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
      case "type_alias": {
        const name = namedIdentifier(node);
        if (name) {
          symbols.push({
            name,
            kind: "type",
            start_line: startLine(node),
            end_line: endLine(node),
          });
        }
        break;
      }
      case "static_final_declaration": {
        // Declarações top-level e estáticas (`const`/`final`/`static const`).
        // Variáveis locais usam local_variable_declaration e não caem aqui.
        const name = namedIdentifier(node);
        if (name) {
          symbols.push({
            name,
            kind: "variable",
            start_line: startLine(node),
            end_line: endLine(node),
          });
        }
        break;
      }
      case "library_import": {
        const spec = node.descendantsOfType("import_specification")[0];
        const source = spec ? extractDartImportSource(spec) : null;
        if (source) {
          imports.push({ source });
          edges.push({ kind: "imports", to: source, line: startLine(node) });
        }
        break;
      }
      case "argument_part": {
        // `argument_part` ancora toda invocação (até sem args). Edge de call
        // com callee resolvido pelo selector anterior e from_symbol pelo
        // signature que encerra o corpo.
        const callee = dartCallee(node);
        if (callee) {
          edges.push({
            kind: "calls",
            from_symbol: dartEnclosingSymbol(node),
            to: callee,
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
