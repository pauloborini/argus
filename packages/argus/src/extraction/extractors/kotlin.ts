import type { SyntaxNode } from "tree-sitter";
import type { FileExtractionResult } from "../types.js";
import { enclosingSymbolName, endLine, namedIdentifier, startLine, walkTree } from "./ast-utils.js";

const KOTLIN_CALL_DEFINERS: ReadonlySet<string> = new Set([
  "function_declaration",
  "secondary_constructor",
]);

const KOTLIN_OPERATOR_SYMBOL: Readonly<Record<string, string>> = {
  plus: "+",
  minus: "-",
  times: "*",
  div: "/",
  rem: "%",
  get: "[]",
  set: "[]=",
  contains: "in",
  equals: "==",
  invoke: "()",
};

function hasAncestorOfType(node: SyntaxNode, type: string): boolean {
  let current: SyntaxNode | null = node.parent;
  while (current) {
    if (current.type === type) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

const KOTLIN_CLASS_LIKE: ReadonlySet<string> = new Set([
  "class_declaration",
  "object_declaration",
  "companion_object",
]);

/**
 * Container class-like mais próximo de `node` subindo pelos ancestrais.
 * Usado para garantir que os branches de membro do `class_declaration` só
 * tratem membros **diretos** da classe: companion objects, objects e classes
 * aninhadas têm handlers próprios e seriam contados em dobro se o `walkTree`
 * recursivo da classe externa também os capturasse.
 */
function nearestClassLikeAncestor(node: SyntaxNode): SyntaxNode | null {
  let current: SyntaxNode | null = node.parent;
  while (current) {
    if (KOTLIN_CLASS_LIKE.has(current.type)) {
      return current;
    }
    current = current.parent;
  }
  return null;
}

function kotlinCallee(node: SyntaxNode): string | null {
  const navigation = node.descendantsOfType("navigation_expression")[0];
  if (navigation) {
    return navigation.text;
  }
  return namedIdentifier(node);
}

function kotlinClassName(node: SyntaxNode): string | null {
  return node.descendantsOfType("type_identifier")[0]?.text ?? namedIdentifier(node);
}

function isInterfaceDeclaration(node: SyntaxNode): boolean {
  for (let i = 0; i < node.childCount; i++) {
    if (node.child(i)?.type === "interface") {
      return true;
    }
  }
  return false;
}

function isEnumDeclaration(node: SyntaxNode): boolean {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child?.type === "enum") {
      return true;
    }
  }
  return false;
}

function delegationTargetName(specifier: SyntaxNode): string | null {
  const invocation = specifier.descendantsOfType("constructor_invocation")[0];
  if (invocation) {
    const target =
      invocation.descendantsOfType("type_identifier")[0] ??
      invocation.descendantsOfType("user_type")[0];
    if (target) {
      return target.descendantsOfType("type_identifier")[0]?.text ?? target.text.replace(/\(\).*$/, "");
    }
  }
  const userType = specifier.descendantsOfType("user_type")[0];
  if (userType) {
    return userType.descendantsOfType("type_identifier")[0]?.text ?? userType.text;
  }
  return null;
}

function extractKotlinImport(node: SyntaxNode): { source: string; symbols?: string[] } | null {
  const identifier = node.descendantsOfType("identifier")[0]?.text;
  if (!identifier) {
    return null;
  }

  const wildcard = node.descendantsOfType("wildcard_import")[0];
  if (wildcard) {
    return { source: `${identifier}.*` };
  }

  const aliasNode = node.descendantsOfType("import_alias")[0];
  if (aliasNode) {
    const alias = aliasNode.descendantsOfType("type_identifier")[0]?.text
      ?? aliasNode.descendantsOfType("simple_identifier")[0]?.text;
    return alias ? { source: identifier, symbols: [alias] } : { source: identifier };
  }

  return { source: identifier };
}

function kotlinFunctionName(node: SyntaxNode): string | null {
  const hasOperator = node.descendantsOfType("modifiers").some((m) =>
    m.text.includes("operator"),
  );
  if (hasOperator) {
    const opName = node.descendantsOfType("simple_identifier")[0]?.text;
    if (!opName) {
      return null;
    }
    const symbol = KOTLIN_OPERATOR_SYMBOL[opName] ?? opName;
    return `operator${symbol}`;
  }

  let receiverName: string | null = null;
  let name: string | null = null;
  let foundFun = false;
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) {
      continue;
    }
    if (child.type === "fun") {
      foundFun = true;
      continue;
    }
    if (!foundFun) {
      continue;
    }
    if (child.type === "user_type" && !name) {
      receiverName =
        child.descendantsOfType("type_identifier")[0]?.text ?? child.text;
      continue;
    }
    if (child.type === "." && receiverName) {
      continue;
    }
    if (
      (child.type === "simple_identifier" || child.type === "type_identifier") &&
      !name
    ) {
      name = child.text;
      break;
    }
  }

  if (receiverName && name) {
    return `${receiverName}.${name}`;
  }

  return name ?? namedIdentifier(node);
}

function companionObjectName(node: SyntaxNode): string {
  let foundObject = false;
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) {
      continue;
    }
    if (child.type === "object") {
      foundObject = true;
      continue;
    }
    if (foundObject && child.type === "type_identifier") {
      return child.text;
    }
  }
  return "Companion";
}

function extractPropertyName(node: SyntaxNode): string | null {
  return (
    node.descendantsOfType("variable_declaration")[0]?.descendantsOfType("simple_identifier")[0]
      ?.text ?? null
  );
}

function extractClassParameterProperty(param: SyntaxNode): string | null {
  const binding = param.descendantsOfType("binding_pattern_kind")[0]?.text;
  const hasValVar =
    binding === "val" ||
    binding === "var" ||
    param.descendantsOfType("modifiers").some(
      (modifier) => modifier.text.includes("val") || modifier.text.includes("var"),
    );
  if (!hasValVar) {
    return null;
  }
  return param.descendantsOfType("simple_identifier")[0]?.text ?? null;
}

function extractDelegationEdges(
  classNode: SyntaxNode,
  className: string,
): FileExtractionResult["edges"] {
  const edges: FileExtractionResult["edges"] = [];

  walkTree(classNode, (child) => {
    if (child.type !== "delegation_specifier") {
      return;
    }
    const target = delegationTargetName(child);
    if (!target) {
      return;
    }

    const isConstructor = child.descendantsOfType("constructor_invocation").length > 0;
    edges.push({
      kind: isConstructor ? "extends" : "implements",
      from_symbol: className,
      to: target,
      line: startLine(child),
    });
  });

  return edges;
}

export function extractKotlin(root: SyntaxNode): FileExtractionResult {
  const symbols: FileExtractionResult["symbols"] = [];
  const imports: FileExtractionResult["imports"] = [];
  const edges: FileExtractionResult["edges"] = [];

  walkTree(root, (node) => {
    switch (node.type) {
      case "package_header": {
        const packageName = node.descendantsOfType("identifier")[0]?.text;
        if (packageName) {
          symbols.push({
            name: packageName,
            kind: "module",
            start_line: startLine(node),
            end_line: endLine(node),
          });
        }
        break;
      }
      case "function_declaration": {
        if (
          hasAncestorOfType(node, "object_declaration") ||
          hasAncestorOfType(node, "companion_object")
        ) {
          break;
        }
        const name = kotlinFunctionName(node);
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
        const name = kotlinClassName(node);
        if (!name) {
          break;
        }

        const kind = isInterfaceDeclaration(node)
          ? "interface"
          : isEnumDeclaration(node)
            ? "enum"
            : "class";
        symbols.push({
          name,
          kind,
          start_line: startLine(node),
          end_line: endLine(node),
        });

        if (kind === "class" || kind === "interface") {
          edges.push(...extractDelegationEdges(node, name));
        }

        walkTree(node, (child) => {
          // Só membros diretos desta classe; companion/objects/classes aninhadas
          // têm handlers próprios e seriam contados em dobro (ex: const de
          // companion object capturado aqui E pelo branch companion_object).
          if (nearestClassLikeAncestor(child) !== node) {
            return;
          }
          if (child.type === "primary_constructor") {
            symbols.push({
              name,
              kind: "function",
              start_line: startLine(child),
              end_line: endLine(child),
            });
            walkTree(child, (param) => {
              if (param.type !== "class_parameter") {
                return;
              }
              const propName = extractClassParameterProperty(param);
              if (propName) {
                symbols.push({
                  name: propName,
                  kind: "variable",
                  start_line: startLine(param),
                  end_line: endLine(param),
                });
              }
            });
          }
          if (child.type === "secondary_constructor") {
            symbols.push({
              name,
              kind: "function",
              start_line: startLine(child),
              end_line: endLine(child),
            });
          }
          if (child.type === "enum_entry") {
            const entryName = namedIdentifier(child);
            if (entryName) {
              symbols.push({
                name: entryName,
                kind: "variable",
                start_line: startLine(child),
                end_line: endLine(child),
              });
            }
          }
          if (child.type === "property_declaration") {
            const propName = extractPropertyName(child);
            if (propName) {
              symbols.push({
                name: propName,
                kind: "variable",
                start_line: startLine(child),
                end_line: endLine(child),
              });
            }
          }
          if (child.type === "companion_object") {
            const companionName = companionObjectName(child);
            symbols.push({
              name: companionName,
              kind: "class",
              start_line: startLine(child),
              end_line: endLine(child),
            });
            walkTree(child, (inner) => {
              if (inner.type === "function_declaration") {
                const fnName = kotlinFunctionName(inner);
                if (fnName) {
                  symbols.push({
                    name: fnName,
                    kind: "function",
                    start_line: startLine(inner),
                    end_line: endLine(inner),
                  });
                }
              }
              if (inner.type === "property_declaration") {
                const propName = extractPropertyName(inner);
                if (propName) {
                  symbols.push({
                    name: propName,
                    kind: "variable",
                    start_line: startLine(inner),
                    end_line: endLine(inner),
                  });
                }
              }
            });
          }
        });
        break;
      }
      case "object_declaration": {
        const name = kotlinClassName(node);
        if (name) {
          symbols.push({
            name,
            kind: "class",
            start_line: startLine(node),
            end_line: endLine(node),
          });

          walkTree(node, (child) => {
            // Só membros diretos deste object; classes aninhadas têm handler próprio.
            if (nearestClassLikeAncestor(child) !== node) {
              return;
            }
            if (child.type === "property_declaration") {
              const propName = extractPropertyName(child);
              if (propName) {
                symbols.push({
                  name: propName,
                  kind: "variable",
                  start_line: startLine(child),
                  end_line: endLine(child),
                });
              }
            }
            if (child.type === "function_declaration") {
              const fnName = kotlinFunctionName(child);
              if (fnName) {
                symbols.push({
                  name: fnName,
                  kind: "function",
                  start_line: startLine(child),
                  end_line: endLine(child),
                });
              }
            }
          });
        }
        break;
      }
      case "property_declaration": {
        if (node.parent?.type === "source_file") {
          const propName = extractPropertyName(node);
          if (propName) {
            symbols.push({
              name: propName,
              kind: "variable",
              start_line: startLine(node),
              end_line: endLine(node),
            });
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
      case "import_header": {
        const extracted = extractKotlinImport(node);
        if (extracted) {
          imports.push(extracted);
          edges.push({ kind: "imports", to: extracted.source, line: startLine(node) });
        }
        break;
      }
      case "call_expression": {
        const callee = kotlinCallee(node);
        if (callee) {
          const from = enclosingSymbolName(node, KOTLIN_CALL_DEFINERS);
          edges.push({
            kind: "calls",
            from_symbol: from ?? undefined,
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
