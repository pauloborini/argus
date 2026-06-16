import type { SyntaxNode } from "tree-sitter";

export function startLine(node: SyntaxNode): number {
  return node.startPosition.row + 1;
}

export function endLine(node: SyntaxNode): number {
  return node.endPosition.row + 1;
}

export function walkTree(node: SyntaxNode, visitor: (node: SyntaxNode) => void): void {
  visitor(node);
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) {
      walkTree(child, visitor);
    }
  }
}

export function childByField(node: SyntaxNode, fieldName: string): SyntaxNode | null {
  return node.childForFieldName(fieldName);
}

export function firstNamedChildOfType(node: SyntaxNode, type: string): SyntaxNode | null {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child?.type === type) {
      return child;
    }
  }
  return null;
}

export function namedIdentifier(node: SyntaxNode): string | null {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (
      child &&
      (child.type === "identifier" ||
        child.type === "type_identifier" ||
        child.type === "property_identifier" ||
        child.type === "simple_identifier")
    ) {
      return child.text;
    }
  }
  return null;
}

export function stripQuotes(value: string): string {
  return value.replace(/^['"`]|['"`]$/g, "");
}
