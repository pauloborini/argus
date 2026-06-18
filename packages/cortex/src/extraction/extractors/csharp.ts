import type { SyntaxNode } from "tree-sitter";
import type { FileExtractionResult } from "../types.js";
import { enclosingSymbolName, endLine, namedIdentifier, startLine, walkTree } from "./ast-utils.js";

/**
 * Tipos de nó que definem um "membro invocador" para atribuição de from_symbol
 * em edges calls/references.
 */
const CSHARP_CALL_DEFINERS: ReadonlySet<string> = new Set([
  "method_declaration",
  "constructor_declaration",
  "local_function_statement",
]);

/**
 * Tipos de nó que definem containers class-like em C#.
 * Usado para o guard de membro direto (evitar dup em tipo aninhado).
 */
const CSHARP_CLASS_LIKE: ReadonlySet<string> = new Set([
  "class_declaration",
  "struct_declaration",
  "record_declaration",
  "interface_declaration",
]);

/**
 * Retorna o container class-like mais próximo subindo pelos ancestrais.
 */
function nearestClassLikeAncestor(node: SyntaxNode): SyntaxNode | null {
  let current: SyntaxNode | null = node.parent;
  while (current) {
    if (CSHARP_CLASS_LIKE.has(current.type)) {
      return current;
    }
    current = current.parent;
  }
  return null;
}

/**
 * Extrai o nome qualificado de um namespace (qualified_name ou identifier).
 */
function extractNamespaceName(node: SyntaxNode): string | null {
  const qualified = node.descendantsOfType("qualified_name")[0];
  if (qualified) {
    return qualified.text;
  }
  return namedIdentifier(node);
}

/**
 * Extrai o source de um using_directive.
 * Formas: using X; using static X; global using X; using Alias = X;
 */
function extractUsingSource(node: SyntaxNode): { source: string; symbols?: string[] } | null {
  // Alias: using Alias = Qualified.Name;
  const hasEquals = node.children.some((c) => c.type === "=");
  if (hasEquals) {
    const aliasName = namedIdentifier(node);
    const qualified = node.descendantsOfType("qualified_name")[0];
    const target = qualified?.text;
    if (target && aliasName) {
      return { source: target, symbols: [aliasName] };
    }
    return target ? { source: target } : null;
  }

  // Normal / static / global: pick qualified_name or identifier
  const qualified = node.descendantsOfType("qualified_name")[0];
  if (qualified) {
    return { source: qualified.text };
  }
  const id = node.children.find(
    (c) => c.type === "identifier" && c.text !== "global",
  );
  return id ? { source: id.text } : null;
}

/**
 * Distingue extends/implements na base_list.
 * Structs/records não herdam classes em C# — tudo é implements.
 * Classes: primeiro item não-interface na lista = extends (herança única);
 * heurística "I"+maiúscula identifica interfaces (limitação conhecida: classes
 * com prefixo "I" como IdentityService seriam classificadas errado).
 */
function extractBaseListEdges(
  baseList: SyntaxNode,
  ownerName: string,
  ownerIsInterface: boolean,
  ownerIsStruct: boolean,
): FileExtractionResult["edges"] {
  const edges: FileExtractionResult["edges"] = [];
  const identifiers = baseList.children.filter(
    (c) => c.type === "identifier" || c.type === "generic_name" || c.type === "qualified_name",
  );

  let extendsAssigned = false;
  for (const id of identifiers) {
    const name = id.type === "generic_name"
      ? (id.descendantsOfType("identifier")[0]?.text ?? id.text)
      : id.text;

    if (ownerIsInterface || ownerIsStruct) {
      edges.push({ kind: "implements", from_symbol: ownerName, to: name, line: startLine(id) });
    } else if (!extendsAssigned && !looksLikeInterface(name)) {
      edges.push({ kind: "extends", from_symbol: ownerName, to: name, line: startLine(id) });
      extendsAssigned = true;
    } else {
      edges.push({ kind: "implements", from_symbol: ownerName, to: name, line: startLine(id) });
    }
  }
  return edges;
}

/**
 * Heurística: nomes que começam com "I" seguido de maiúscula são interfaces.
 */
function looksLikeInterface(name: string): boolean {
  return name.length >= 2 && name[0] === "I" && name[1]! >= "A" && name[1]! <= "Z";
}

/**
 * Extrai o callee de um invocation_expression.
 * Formas: obj.Method(...) → "obj.Method"; Method(...) → "Method"
 */
function extractInvocationCallee(node: SyntaxNode): string | null {
  const memberAccess = node.children.find((c) => c.type === "member_access_expression");
  if (memberAccess) {
    return memberAccess.text.replace(/\s+/g, "");
  }
  const id = node.children.find((c) => c.type === "identifier");
  return id?.text ?? null;
}

/**
 * Extrai o tipo sendo instanciado em object_creation_expression.
 * Formas: new T(...) → "T"; new Ns.T(...) → "Ns.T"
 */
function extractObjectCreationType(node: SyntaxNode): string | null {
  const qualified = node.descendantsOfType("qualified_name")[0];
  if (qualified) {
    return qualified.text;
  }
  const generic = node.children.find((c) => c.type === "generic_name");
  if (generic) {
    return generic.descendantsOfType("identifier")[0]?.text ?? generic.text;
  }
  const id = node.children.find((c) => c.type === "identifier");
  return id?.text ?? null;
}

export function extractCSharp(root: SyntaxNode): FileExtractionResult {
  const symbols: FileExtractionResult["symbols"] = [];
  const imports: FileExtractionResult["imports"] = [];
  const edges: FileExtractionResult["edges"] = [];

  walkTree(root, (node) => {
    switch (node.type) {
      // --- Namespaces ---
      case "namespace_declaration":
      case "file_scoped_namespace_declaration": {
        const name = extractNamespaceName(node);
        if (name) {
          symbols.push({
            name,
            kind: "module",
            start_line: startLine(node),
            end_line: endLine(node),
          });
        }
        break;
      }

      // --- Using directives ---
      case "using_directive": {
        const extracted = extractUsingSource(node);
        if (extracted) {
          imports.push(extracted);
          edges.push({ kind: "imports", to: extracted.source, line: startLine(node) });
        }
        break;
      }

      // --- Type declarations ---
      case "class_declaration":
      case "struct_declaration":
      case "record_declaration": {
        const name = namedIdentifier(node);
        if (!name) break;

        const isStruct = node.type === "struct_declaration"
          || (node.type === "record_declaration" && node.children.some((c) => c.type === "struct"));

        symbols.push({
          name,
          kind: "class",
          start_line: startLine(node),
          end_line: endLine(node),
        });

        // Base list
        const baseList = node.children.find((c) => c.type === "base_list");
        if (baseList) {
          edges.push(...extractBaseListEdges(baseList, name, false, isStruct));
        }

        // Members (direct only — guard via nearestClassLikeAncestor)
        walkTree(node, (child) => {
          if (nearestClassLikeAncestor(child) !== node) return;

          switch (child.type) {
            case "constructor_declaration": {
              symbols.push({
                name,
                kind: "function",
                start_line: startLine(child),
                end_line: endLine(child),
              });
              break;
            }
            case "method_declaration": {
              const mName = namedIdentifier(child);
              if (mName) {
                symbols.push({
                  name: mName,
                  kind: "function",
                  start_line: startLine(child),
                  end_line: endLine(child),
                });
              }
              break;
            }
            case "local_function_statement": {
              const lfName = namedIdentifier(child);
              if (lfName) {
                symbols.push({
                  name: lfName,
                  kind: "function",
                  start_line: startLine(child),
                  end_line: endLine(child),
                });
              }
              break;
            }
            case "property_declaration": {
              const pName = namedIdentifier(child);
              if (pName) {
                symbols.push({
                  name: pName,
                  kind: "variable",
                  start_line: startLine(child),
                  end_line: endLine(child),
                });
              }
              break;
            }
            case "field_declaration": {
              const declarator = child.descendantsOfType("variable_declarator")[0];
              const fName = declarator ? namedIdentifier(declarator) : null;
              if (fName) {
                symbols.push({
                  name: fName,
                  kind: "variable",
                  start_line: startLine(child),
                  end_line: endLine(child),
                });
              }
              break;
            }
            case "event_field_declaration": {
              const evDeclarator = child.descendantsOfType("variable_declarator")[0];
              const evName = evDeclarator ? namedIdentifier(evDeclarator) : null;
              if (evName) {
                symbols.push({
                  name: evName,
                  kind: "variable",
                  start_line: startLine(child),
                  end_line: endLine(child),
                });
              }
              break;
            }
            default:
              break;
          }
        });
        break;
      }

      case "interface_declaration": {
        const name = namedIdentifier(node);
        if (!name) break;

        symbols.push({
          name,
          kind: "interface",
          start_line: startLine(node),
          end_line: endLine(node),
        });

        const baseList = node.children.find((c) => c.type === "base_list");
        if (baseList) {
          edges.push(...extractBaseListEdges(baseList, name, true, false));
        }

        // Interface method signatures
        walkTree(node, (child) => {
          if (nearestClassLikeAncestor(child) !== node) return;
          if (child.type === "method_declaration") {
            const mName = namedIdentifier(child);
            if (mName) {
              symbols.push({
                name: mName,
                kind: "function",
                start_line: startLine(child),
                end_line: endLine(child),
              });
            }
          }
          if (child.type === "property_declaration") {
            const pName = namedIdentifier(child);
            if (pName) {
              symbols.push({
                name: pName,
                kind: "variable",
                start_line: startLine(child),
                end_line: endLine(child),
              });
            }
          }
        });
        break;
      }

      case "enum_declaration": {
        const name = namedIdentifier(node);
        if (!name) break;

        symbols.push({
          name,
          kind: "enum",
          start_line: startLine(node),
          end_line: endLine(node),
        });

        // Enum members
        walkTree(node, (child) => {
          if (child.type === "enum_member_declaration") {
            const mName = namedIdentifier(child);
            if (mName) {
              symbols.push({
                name: mName,
                kind: "variable",
                start_line: startLine(child),
                end_line: endLine(child),
              });
            }
          }
        });
        break;
      }

      case "delegate_declaration": {
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

      // --- Invocations and object creation ---
      case "invocation_expression": {
        const callee = extractInvocationCallee(node);
        if (callee) {
          const from = enclosingSymbolName(node, CSHARP_CALL_DEFINERS);
          edges.push({
            kind: "calls",
            from_symbol: from ?? undefined,
            to: callee,
            line: startLine(node),
          });
        }
        break;
      }

      case "object_creation_expression": {
        const typeName = extractObjectCreationType(node);
        if (typeName) {
          const from = enclosingSymbolName(node, CSHARP_CALL_DEFINERS);
          edges.push({
            kind: "calls",
            from_symbol: from ?? undefined,
            to: typeName,
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
