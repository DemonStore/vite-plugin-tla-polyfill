import type {
  Program,
  ImportDeclaration,
  ExportNamedDeclaration,
  ExportDefaultDeclaration,
  ExportAllDeclaration,
  VariableDeclaration,
  FunctionDeclaration,
  ClassDeclaration,
  Statement,
  ModuleDeclaration,
  Pattern,
  Node
} from "estree";
import MagicString from "magic-string";
import type { BundleGraph, Options } from "./types";
import { resolveImport } from "./utils/resolve-import";

interface TransformResult {
  code: string;
  map: ReturnType<MagicString["generateMap"]>;
}

export function transformChunk(
  code: string,
  ast: Program,
  chunkName: string,
  graph: BundleGraph,
  options: Required<Options>
): TransformResult {
  const s = new MagicString(code);

  // --- Phase 1: Classify statements and process export declarations ---
  const imports: ImportDeclaration[] = [];
  const exportFroms: (ExportNamedDeclaration | ExportAllDeclaration)[] = [];
  const namedExports: ExportNamedDeclaration[] = []; // export { x, y } without source
  const bodyStmts: { node: Statement | ModuleDeclaration; start: number; end: number }[] = [];

  const exportMap: Record<string, string> = {}; // exportedName -> localName
  const hoistedExportNames = new Set<string>(); // function/class names that need hoisting

  let defaultCounter = 0;

  for (const stmt of ast.body) {
    const start = stmt.start!;
    const end = stmt.end!;

    switch (stmt.type) {
      case "ImportDeclaration":
        imports.push(stmt);
        break;

      case "ExportAllDeclaration":
        exportFroms.push(stmt);
        break;

      case "ExportNamedDeclaration":
        if (stmt.source) {
          exportFroms.push(stmt);
        } else if (stmt.declaration) {
          const decl = stmt.declaration;
          if (decl.type === "FunctionDeclaration" || decl.type === "ClassDeclaration") {
            const name = decl.id!.name;
            exportMap[name] = name;
            hoistedExportNames.add(name);
            // Remove "export " keyword, keep the declaration
            s.remove(start, decl.start!);
            bodyStmts.push({ node: decl, start: decl.start!, end });
          } else if (decl.type === "VariableDeclaration") {
            // export const x = ...; — remove "export ", treat as body
            s.remove(start, decl.start!);
            // Add names to export map
            for (const d of decl.declarations) {
              for (const name of resolvePatternNames(d.id)) {
                exportMap[name] = name;
              }
            }
            bodyStmts.push({ node: decl, start: decl.start!, end });
          }
        } else {
          // export { x, y as z }
          for (const spec of stmt.specifiers) {
            if (spec.type === "ExportSpecifier") {
              const exported = spec.exported;
              const exportedName = exported.type === "Identifier"
                ? exported.name : String((exported as any).value);
              const localName = spec.local.type === "Identifier"
                ? spec.local.name : String((spec.local as any).value);
              exportMap[exportedName] = localName;
            }
          }
          namedExports.push(stmt);
        }
        break;

      case "ExportDefaultDeclaration": {
        const decl = stmt.declaration;
        if (decl.type === "FunctionDeclaration" || decl.type === "ClassDeclaration") {
          if (decl.id) {
            exportMap["default"] = decl.id.name;
            hoistedExportNames.add(decl.id.name);
            // Remove "export default "
            s.remove(start, decl.start!);
            bodyStmts.push({ node: decl, start: decl.start!, end });
          } else {
            const name = `__tla_default_${defaultCounter++}`;
            exportMap["default"] = name;
            // Replace "export default function/class" with "let __name = function/class"
            s.overwrite(start, (decl as any).start!, `let ${name} = `);
            bodyStmts.push({ node: stmt, start, end });
          }
        } else {
          // export default <expression>
          const name = `__tla_default_${defaultCounter++}`;
          exportMap["default"] = name;
          s.overwrite(start, (decl as any).start!, `let ${name} = `);
          bodyStmts.push({ node: stmt, start, end });
        }
        break;
      }

      default:
        bodyStmts.push({ node: stmt, start, end });
        break;
    }
  }

  // --- Phase 2: Build export bindings ---
  const exportedLocalNames = new Set(Object.values(exportMap));

  // For ALL exported function/class declarations, use __tla_export_X bindings
  // to preserve hoisting behavior (both `export function f` and plain `function f` with `export { f }`)
  const exportBindingsByLocal: Record<string, string> = {};
  for (const { node } of bodyStmts) {
    if (
      (node.type === "FunctionDeclaration" || node.type === "ClassDeclaration") &&
      node.id && exportedLocalNames.has(node.id.name)
    ) {
      exportBindingsByLocal[node.id.name] = `__tla_export_${node.id.name}`;
    }
  }

  const exportBindings: Record<string, string> = {};
  for (const [exportedName, localName] of Object.entries(exportMap)) {
    exportBindings[exportedName] = exportBindingsByLocal[localName] ?? localName;
  }

  const exportedBindingNames = [...new Set(Object.values(exportBindings))];

  // Names imported by import declarations (don't re-declare these)
  const importedNames = new Set<string>();
  for (const imp of imports) {
    for (const spec of imp.specifiers) importedNames.add(spec.local.name);
  }

  // Names from export-from (don't re-declare)
  const exportFromedNames = new Set<string>();
  for (const ef of exportFroms) {
    if (ef.type !== "ExportNamedDeclaration") continue;
    for (const spec of ef.specifiers) {
      if (spec.type === "ExportSpecifier") {
        const name = spec.exported.type === "Identifier"
          ? spec.exported.name : (spec.exported as any).value;
        exportFromedNames.add(name);
      } else if (spec.type === "ExportNamespaceSpecifier") {
        const name = spec.exported.type === "Identifier"
          ? spec.exported.name : (spec.exported as any).value;
        exportFromedNames.add(name);
      }
    }
  }

  // Hoisted declarations: exported binding names that aren't already declared by imports/exportFroms
  const hoistDeclNames = exportedBindingNames.filter(
    n => !importedNames.has(n) && !exportFromedNames.has(n)
  );

  // --- Phase 3: Transform body statements ---
  for (const { node, start, end } of bodyStmts) {
    if (node.type === "VariableDeclaration") {
      transformVariableDecl(s, node, exportedLocalNames);
    } else if (
      (node.type === "FunctionDeclaration" || node.type === "ClassDeclaration") &&
      node.id && exportedLocalNames.has(node.id.name)
    ) {
      const bindingName = exportBindingsByLocal[node.id.name];
      if (bindingName) {
        // Append assignment after declaration
        s.appendLeft(end, `\n${bindingName} = ${node.id.name};`);
      }
    }
  }

  // --- Phase 4: Transform dynamic imports ---
  transformDynamicImports(s, ast, chunkName, graph, options);

  // --- Phase 5: Add TLA promise imports ---
  let importedPromiseCount = 0;

  for (const imp of imports) {
    const importedModule = resolveImport(chunkName, imp.source.value as string);
    if (!importedModule || !graph[importedModule]?.transformNeeded) continue;

    const alias = options.promiseImportName(importedPromiseCount);
    const specStr = `${options.promiseExportName} as ${alias}`;

    if (imp.specifiers.length > 0) {
      const lastSpec = imp.specifiers[imp.specifiers.length - 1];
      if (lastSpec.type === 'ImportSpecifier') {
        // Already inside { }, can append named specifier directly
        s.appendRight(lastSpec.end!, `, ${specStr}`);
      } else {
        // Default or namespace specifier — must wrap in { } to produce valid ESM syntax
        // e.g. `import foo from '...'` → `import foo, { __tla as __tla_0 } from '...'`
        s.appendRight(lastSpec.end!, `, { ${specStr} }`);
      }
    } else {
      // Side-effect import: import "./b" → import { __tla as __tla_0 } from "./b"
      s.appendLeft((imp.source as any).start!, `{ ${specStr} } from `);
    }
    importedPromiseCount++;
  }

  for (const ef of exportFroms) {
    const source = ef.source;
    if (!source) continue;
    const importedModule = resolveImport(chunkName, source.value as string);
    if (!importedModule || !graph[importedModule]?.transformNeeded) continue;

    const alias = options.promiseImportName(importedPromiseCount);
    s.appendLeft(
      ef.start!,
      `import { ${options.promiseExportName} as ${alias} } from ${JSON.stringify(source.value)};\n`
    );
    importedPromiseCount++;
  }

  // --- Phase 6: Build IIFE wrapper ---
  const promiseArrayStr = importedPromiseCount > 0
    ? `Promise.all([${Array.from({ length: importedPromiseCount }, (_, i) =>
        `(() => { try { return ${options.promiseImportName(i)}; } catch {} })()`
      ).join(", ")}]).then(async () => {\n`
    : `(async () => {\n`;

  const promiseCloseStr = importedPromiseCount > 0 ? `\n})` : `\n})()`;

  const hasImporters = graph[chunkName]?.importedBy?.length > 0;
  const hasExports = Object.keys(exportMap).length > 0;
  const needsExport = hasExports || hasImporters;

  // Remove old named export declarations
  for (const ne of namedExports) {
    s.remove(ne.start!, ne.end!);
  }

  const hoistDeclStr = hoistDeclNames.length > 0 ? `let ${hoistDeclNames.join(", ")};\n` : "";

  if (needsExport) {
    exportBindings[options.promiseExportName] = options.promiseExportName;
  }

  const exportListStr = needsExport
    ? `\nexport { ${Object.entries(exportBindings)
        .map(([exp, loc]) => exp === loc ? exp : `${loc} as ${exp}`)
        .join(", ")} };\n`
    : "";

  if (bodyStmts.length > 0) {
    const firstStart = bodyStmts[0].start;
    const lastEnd = bodyStmts[bodyStmts.length - 1].end;

    if (needsExport) {
      s.appendLeft(firstStart, `${hoistDeclStr}let ${options.promiseExportName} = ${promiseArrayStr}`);
      s.appendRight(lastEnd, `${promiseCloseStr};${exportListStr}`);
    } else {
      s.appendLeft(firstStart, `${hoistDeclStr}${promiseArrayStr}`);
      s.appendRight(lastEnd, `${promiseCloseStr};\n`);
    }
  } else {
    // No body — still need to create the promise wrapper for awaiting dependencies
    const insertPoint = namedExports.length > 0
      ? namedExports[0].start!
      : (ast.body.length > 0 ? ast.body[ast.body.length - 1].end! : 0);

    if (needsExport) {
      const wrapperStr = `${hoistDeclStr}let ${options.promiseExportName} = ${promiseArrayStr}${promiseCloseStr};${exportListStr}`;
      s.appendRight(insertPoint, wrapperStr);
    } else {
      s.appendRight(insertPoint, `${hoistDeclStr}${promiseArrayStr}${promiseCloseStr};\n`);
    }
  }

  return {
    code: s.toString(),
    map: s.generateMap({ hires: true })
  };
}

function transformVariableDecl(
  s: MagicString,
  stmt: VariableDeclaration,
  exportedNames: Set<string>
): void {
  for (const decl of stmt.declarations) {
    const names = resolvePatternNames(decl.id);
    const exportedDeclNames = names.filter(n => exportedNames.has(n));
    if (exportedDeclNames.length === 0) continue;

    const unexportedNames = names.filter(n => !exportedNames.has(n));

    if (stmt.declarations.length === 1) {
      // Single declarator — we can transform in place
      // Remove "const/let/var " keyword
      s.remove(stmt.start!, decl.id.start!);

      // Declare unexported names inside the IIFE (before this statement)
      if (unexportedNames.length > 0) {
        s.appendLeft(decl.id.start!, `let ${unexportedNames.join(", ")};\n`);
      }

      // For ObjectPattern, wrap in parens to avoid ambiguity with block statements
      // ArrayPattern doesn't need parens
      if (decl.id.type === "ObjectPattern") {
        s.appendLeft(decl.id.start!, "(");
        const endChar = s.original[stmt.end! - 1];
        if (endChar === ";") {
          s.appendLeft(stmt.end! - 1, ")");
        } else {
          s.appendRight(stmt.end!, ")");
        }
      }
    } else {
      // Multiple declarators in same declaration — rare in Rollup output
      // Remove the keyword, convert to individual assignments
      s.remove(stmt.start!, stmt.declarations[0].id.start!);
      if (unexportedNames.length > 0) {
        s.appendLeft(stmt.declarations[0].id.start!, `let ${unexportedNames.join(", ")};\n`);
      }
    }
  }
}

function transformDynamicImports(
  s: MagicString,
  ast: Program,
  chunkName: string,
  graph: BundleGraph,
  options: Required<Options>
): void {
  walkNode(ast, (node: any) => {
    if (node.type === "ImportExpression") {
      const arg = node.source;
      if (arg.type === "Literal" && typeof arg.value === "string") {
        const importedModule = resolveImport(chunkName, arg.value);
        if (importedModule && !graph[importedModule]?.transformNeeded) return;
      }
      s.appendRight(
        node.end!,
        `.then(async m => { await m.${options.promiseExportName}; return m; })`
      );
    }
  });
}

function walkNode(node: any, visitor: (node: any) => void): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) walkNode(child, visitor);
    return;
  }
  if (node.type) visitor(node);
  for (const key of Object.keys(node)) {
    if (key === "type" || key === "start" || key === "end" || key === "loc" || key === "range") continue;
    const child = node[key];
    if (child && typeof child === "object") walkNode(child, visitor);
  }
}

export function resolvePatternNames(pattern: Pattern): string[] {
  switch (pattern.type) {
    case "Identifier":
      return [pattern.name];
    case "ObjectPattern":
      return pattern.properties.flatMap(prop => {
        if (prop.type === "RestElement") return resolvePatternNames(prop.argument);
        return resolvePatternNames(prop.value);
      });
    case "ArrayPattern":
      return pattern.elements
        .filter((elem): elem is Pattern => elem !== null)
        .flatMap(elem => {
          if (elem.type === "RestElement") return resolvePatternNames(elem.argument);
          return resolvePatternNames(elem);
        });
    case "AssignmentPattern":
      return resolvePatternNames(pattern.left);
    default:
      return [];
  }
}
