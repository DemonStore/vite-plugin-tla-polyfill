import type { Program } from "estree";

export interface DetectResult {
  hasTLA: boolean;
  hasDynamicImport: boolean;
}

export function detect(ast: Program): DetectResult {
  return detectWalk(ast, 0, { hasTLA: false, hasDynamicImport: false });
}

function detectWalk(node: any, depth: number, result: DetectResult): DetectResult {
  if (!node || typeof node !== "object") return result;

  if (Array.isArray(node)) {
    for (const child of node) detectWalk(child, depth, result);
    return result;
  }

  switch (node.type) {
    case "AwaitExpression":
      if (depth === 0) result.hasTLA = true;
      detectWalk(node.argument, depth, result);
      break;

    case "ForOfStatement":
      if (node.await && depth === 0) result.hasTLA = true;
      detectWalk(node.left, depth, result);
      detectWalk(node.right, depth, result);
      detectWalk(node.body, depth, result);
      break;

    // These create new scope — increase depth
    case "FunctionDeclaration":
    case "FunctionExpression":
    case "ArrowFunctionExpression":
      detectWalk(node.body, depth + 1, result);
      break;

    case "ClassDeclaration":
    case "ClassExpression":
      detectWalk(node.body, depth + 1, result);
      break;

    case "MethodDefinition":
    case "PropertyDefinition":
    case "Property":
      if (node.value) detectWalk(node.value, depth, result);
      break;

    case "ImportExpression":
      result.hasDynamicImport = true;
      break;

    default: {
      for (const key of Object.keys(node)) {
        if (key === "type" || key === "start" || key === "end" || key === "loc" || key === "range") continue;
        const child = node[key];
        if (child && typeof child === "object") detectWalk(child, depth, result);
      }
      break;
    }
  }

  return result;
}
