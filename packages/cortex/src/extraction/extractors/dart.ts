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
    if (current.type === "function_body" || current.type === "constructor_body") {
      const sig = current.previousNamedSibling;
      if (sig) {
        const fnSig =
          sig.type === "function_signature"
            ? sig
            : sig.descendantsOfType("function_signature")[0] ??
              sig.descendantsOfType("constructor_signature")[0] ??
              sig.descendantsOfType("factory_constructor_signature")[0] ??
              sig;
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
  if (prev.type === "type_identifier") {
    // Instanciação implícita: `Widget(...)` — callee é o nome do tipo.
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

/**
 * Nome de construtor Dart a partir de `constructor_signature` ou
 * `factory_constructor_signature`. Para o construtor default `A()`, retorna
 * `A`. Para construtor nomeado `A.named()`, retorna `A.named`. Para factory
 * `factory A.create()`, retorna `A.create`.
 *
 * No tree-sitter-dart, `constructor_signature` tem o par `identifier [. identifier]`
 * como filhos diretos antes do `formal_parameter_list` — o field `name` só
 * aponta para o primeiro identifier, então lemos os filhos diretos manualmente.
 */
function dartConstructorName(node: SyntaxNode): string | null {
  if (node.type === "constructor_signature") {
    // Coletar identifiers diretos antes do formal_parameter_list
    const parts: string[] = [];
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (!child) continue;
      if (child.type === "formal_parameter_list") break;
      if (child.type === "identifier") {
        parts.push(child.text);
      }
    }
    return parts.length > 0 ? parts.join(".") : null;
  }
  if (
    node.type === "factory_constructor_signature" ||
    node.type === "redirecting_factory_constructor_signature" ||
    node.type === "constant_constructor_signature"
  ) {
    // Para factory/redirecting: `factory Foo.named` — identifiers diretos após keyword.
    // Para constant: `const Icon.outlined` — o nome fica em nó `qualified` (ex:
    // `qualified "Icon.outlined"` com filhos identifier+dot+identifier).
    // Tentamos `qualified` primeiro; se não existir, caímos para identifiers diretos.
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.type === "qualified") {
        // `qualified` contem os identifiers separados por ponto; `.text` já é "Foo.named"
        return child.text;
      }
    }
    // Fallback: identifiers diretos (factory sem `qualified`)
    const ids: string[] = [];
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.type === "identifier") {
        ids.push(child.text);
        if (ids.length === 2) break; // no máximo ClassName.factoryName
      }
    }
    if (ids.length > 0) {
      return ids.join(".");
    }
  }
  return null;
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

      // Operator overloading: `Vec operator +(Vec other)`, `bool operator ==(Object o)`.
      // Comum em classes de valor Flutter: Color, Size, EdgeInsets, Offset usam
      // `operator ==` e `operator []`. Node type `operator_signature` é filho de
      // `method_signature` e não tem field `name` — o símbolo fica no nó filho
      // binary_operator/unary_operator que vem após o keyword `operator`.
      // Modelado como `operator+`, `operator==`, `operator[]` para search navegável.
      //
      // LIMITAÇÕES DE PARSER (tree-sitter-dart versão atual):
      // - Enhanced enums (Dart 2.17+): `enum E { a('x'); const E(this.v); }` —
      //   o parser gera ERROR; apenas o primeiro membro sem args é extraído.
      // - Sealed classes (Dart 3): `sealed class S {}` — gera ERROR; classe se perde.
      // - Record types (Dart 3): `(int, String) fn()` — gera ERROR no método.
      // Esses limites dependem de atualizar o pacote tree-sitter-dart, não do extrator.
      case "operator_signature": {
        // Percorre filhos buscando o nó do operador (vem após o keyword `operator`).
        // Pode ser: binary_operator, unary_operator, `[]`, `[]=`.
        let foundOperatorKw = false;
        let opText: string | null = null;
        for (let i = 0; i < node.childCount; i++) {
          const child = node.child(i);
          if (!child) continue;
          if (child.type === "operator") {
            foundOperatorKw = true;
            continue;
          }
          if (foundOperatorKw && child.type !== "formal_parameter_list") {
            opText = child.text;
            break;
          }
        }
        if (opText) {
          symbols.push({
            name: `operator${opText}`,
            kind: "function",
            start_line: startLine(node),
            end_line: endLine(node),
          });
        }
        break;
      }


      // Construtores: default/nomeado (constructor_signature) e
      // factory/const (factory_constructor_signature,
      // constant_constructor_signature, redirecting_factory_constructor_signature).
      // São os entrypoints mais usados de um widget Flutter.
      case "constructor_signature":
      case "factory_constructor_signature":
      case "redirecting_factory_constructor_signature":
      case "constant_constructor_signature": {
        const name = dartConstructorName(node);
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

      // Membros de enum (ex: Status.active, Status.inactive).
      // `enum_constant` é filho direto de `enum_declaration`.
      case "enum_constant": {
        const nameField = node.childForFieldName("name");
        const name = nameField?.text ?? namedIdentifier(node);
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

      // Campos de instância de classe. O node type real na grammar tree-sitter-dart
      // para membro de classe é `declaration` filho direto de `class_body`.
      // O nome fica em `initialized_identifier` → `identifier`.
      // Campos `static const` caem em `static_final_declaration` e já são extraídos.
      case "declaration": {
        if (node.parent?.type === "class_body") {
          // Cada `initialized_identifier` dentro da declaration é um campo.
          const idList = node.descendantsOfType("initialized_identifier");
          for (const id of idList) {
            const nameNode = id.descendantsOfType("identifier")[0];
            if (nameNode) {
              symbols.push({
                name: nameNode.text,
                kind: "variable",
                start_line: startLine(id),
                end_line: endLine(id),
              });
            }
          }
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

      // `part 'foo.dart'` — fragmento da biblioteca. Integra o grafo de imports
      // para que impacto em um arquivo part propague ao arquivo raiz e vice-versa.
      case "part_directive": {
        const uriNode = node.descendantsOfType("uri")[0];
        const source = uriNode ? stripQuotes(uriNode.text) : null;
        if (source) {
          imports.push({ source });
          edges.push({ kind: "imports", to: source, line: startLine(node) });
        }
        break;
      }

      // `part of 'lib.dart'` ou `part of lib.name` — conecta a parte à biblioteca
      // principal como edge de imports (bidirecional por convenção).
      case "part_of_directive": {
        const uriNode = node.descendantsOfType("uri")[0];
        // `part of` com URI string
        if (uriNode) {
          const source = stripQuotes(uriNode.text);
          imports.push({ source });
          edges.push({ kind: "imports", to: source, line: startLine(node) });
        } else {
          // `part of lib.name` — dotted identifier; tratamos como referência nominal
          const dotted = node.descendantsOfType("dotted_identifier_list")[0]?.text;
          if (dotted) {
            imports.push({ source: dotted });
            edges.push({ kind: "imports", to: dotted, line: startLine(node) });
          }
        }
        break;
      }

      // `export 'dart:math'` / `export 'src/models.dart'` — re-export propaga
      // impacto: mudar o módulo exportado afeta quem importa o barrel.
      case "library_export": {
        const source = extractDartImportSource(node);
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

      // Cascade (`..method()`, `..property`): cada seção de cascade conecta
      // o receptor aos seus métodos/propriedades encadeados como edges de calls.
      case "cascade_section": {
        const selector = node.descendantsOfType("cascade_selector")[0];
        if (selector) {
          // O cascade_selector contém o identifier do método ou property_identifier
          const callee =
            selector.descendantsOfType("identifier")[0]?.text ??
            selector.descendantsOfType("property_identifier")[0]?.text;
          if (callee) {
            edges.push({
              kind: "calls",
              from_symbol: dartEnclosingSymbol(node),
              to: callee,
              line: startLine(node),
            });
          }
        }
        break;
      }

      default:
        break;
    }
  });

  return { symbols, imports, edges, parse_errors: [] };
}
