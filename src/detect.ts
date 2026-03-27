import type { Node, Program } from "estree";
import { simple } from "acorn-walk";

export interface DetectResult {
  hasTLA: boolean;
  hasDynamicImport: boolean;
}

export function detect(ast: Program): DetectResult {
  let hasTLA = false;
  let hasDynamicImport = false;

  // Track nesting depth: functions/classes/methods increase depth,
  // only level-0 awaits are top-level
  let depth = 0;

  simple(ast as Node, {
    Function(node: any) {
      // acorn-walk's simple() does NOT descend into children automatically
      // for explicitly handled node types, but it DOES for functions
      // when we use "Function" as the catch-all.
      // We need ancestor-aware walking instead.
    },
    ImportExpression() {
      hasDynamicImport = true;
    }
  });

  // For TLA detection we need depth tracking, use manual recursive walk
  hasTLA = hasTLAWalk(ast);

  return { hasTLA, hasDynamicImport };
}

function hasTLAWalk(node: any, depth: number = 0): boolean {
  if (!node || typeof node !== "object") return false;

  if (Array.isArray(node)) {
    return node.some(child => hasTLAWalk(child, depth));
  }

  switch (node.type) {
    case "AwaitExpression":
      if (depth === 0) return true;
      return hasTLAWalk(node.argument, depth);

    case "ForOfStatement":
      if (node.await && depth === 0) return true;
      return hasTLAWalk(node.left, depth) || hasTLAWalk(node.right, depth) || hasTLAWalk(node.body, depth);

    // These create new scope — increase depth
    case "FunctionDeclaration":
    case "FunctionExpression":
    case "ArrowFunctionExpression":
      return hasTLAWalk(node.body, depth + 1);

    case "ClassDeclaration":
    case "ClassExpression":
      return hasTLAWalk(node.body, depth + 1);

    case "MethodDefinition":
    case "PropertyDefinition":
    case "Property":
      if (node.value) return hasTLAWalk(node.value, depth);
      return false;

    // Don't descend into ImportExpression — not relevant for TLA
    case "ImportExpression":
      return false;

    default: {
      // Recurse into all child nodes
      for (const key of Object.keys(node)) {
        if (key === "type" || key === "start" || key === "end" || key === "loc" || key === "range") continue;
        const child = node[key];
        if (child && typeof child === "object") {
          if (hasTLAWalk(child, depth)) return true;
        }
      }
      return false;
    }
  }
}
