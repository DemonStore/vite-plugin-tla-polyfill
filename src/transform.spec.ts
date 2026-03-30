import { parse } from "acorn";
import { transformChunk } from "./transform";
import type { BundleGraph, Options } from "./types";

const DEFAULT_OPTIONS: Required<Options> = {
  promiseExportName: "__tla",
  promiseImportName: i => `__tla_${i}`
};

function parseCode(code: string) {
  return parse(code, { ecmaVersion: 2022, sourceType: "module" }) as any;
}

function normalize(code: string): string {
  // Normalize whitespace for comparison
  return code.replace(/\s+/g, " ").trim();
}

describe("transformChunk", () => {
  it("should wrap TLA in async IIFE for module without imports/exports", () => {
    const code = `await globalThis.somePromise;`;
    const graph: BundleGraph = {
      a: { transformNeeded: true, tlaImports: [], importedBy: [] }
    };

    const result = transformChunk(code, parseCode(code), "a", graph, DEFAULT_OPTIONS);

    expect(result.code).toContain("(async () => {");
    expect(result.code).toContain("await globalThis.somePromise;");
    expect(result.code).toContain("})()");
    // Should NOT export __tla if no exports and no importers
    expect(result.code).not.toContain("export");
  });

  it("should add __tla import specifier to imports from transformed modules", () => {
    const code = `import { qwq } from "./b";\nawait globalThis.somePromise;\n`;
    const graph: BundleGraph = {
      a: { transformNeeded: true, tlaImports: ["b"], importedBy: [] },
      b: { transformNeeded: true, tlaImports: [], importedBy: ["a"] }
    };

    const result = transformChunk(code, parseCode(code), "a", graph, DEFAULT_OPTIONS);

    expect(result.code).toContain("__tla as __tla_0");
    expect(result.code).toContain("Promise.all(");
    expect(result.code).toContain("try { return __tla_0; } catch {}");
  });

  it("should export __tla when module has exports", () => {
    const code = `const x = await globalThis.somePromise;\nexport { x };\n`;
    const graph: BundleGraph = {
      a: { transformNeeded: true, tlaImports: [], importedBy: [] }
    };

    const result = transformChunk(code, parseCode(code), "a", graph, DEFAULT_OPTIONS);

    expect(result.code).toContain("let x;");
    expect(result.code).toContain("let __tla =");
    expect(result.code).toContain("export {");
    expect(result.code).toContain("__tla");
  });

  it("should work with imports and exports", () => {
    const code = [
      `import { qwq } from "./b";`,
      `const x = await globalThis.somePromise;`,
      `const y = 1;`,
      `export { x, y as z };`
    ].join("\n");

    const graph: BundleGraph = {
      a: { transformNeeded: true, tlaImports: ["b"], importedBy: [] },
      b: { transformNeeded: true, tlaImports: [], importedBy: ["a"] }
    };

    const result = transformChunk(code, parseCode(code), "a", graph, DEFAULT_OPTIONS);

    expect(result.code).toContain("__tla as __tla_0");
    expect(result.code).toContain("let x, y;");
    expect(result.code).toContain("let __tla = Promise.all(");
    expect(result.code).toContain("export { x, y as z, __tla };");
  });

  it("should handle multiple imports (mixed TLA/non-TLA)", () => {
    const code = [
      `import { qwq } from "./b";`,
      `import { quq as qvq } from "./c";`,
      `import { default as qaq } from "./d";`,
      `const x = await qvq;`,
      `export { x };`
    ].join("\n");

    const graph: BundleGraph = {
      a: { transformNeeded: true, tlaImports: ["b", "d"], importedBy: [] },
      b: { transformNeeded: true, tlaImports: [], importedBy: ["a"] },
      c: { transformNeeded: false, tlaImports: [], importedBy: ["a"] },
      d: { transformNeeded: true, tlaImports: [], importedBy: ["a"] }
    };

    const result = transformChunk(code, parseCode(code), "a", graph, DEFAULT_OPTIONS);

    // Should add __tla specifier to imports from b and d, but not c
    expect(result.code).toContain(`from "./b"`);
    expect(result.code).toContain("__tla as __tla_0");
    expect(result.code).toContain("__tla as __tla_1");
    expect(result.code).toContain("Promise.all(");
    // Two try-catch blocks
    expect(result.code).toContain("__tla_0");
    expect(result.code).toContain("__tla_1");
  });

  it("should handle export function with hoisting", () => {
    const code = [
      `const x = await globalThis.somePromise;`,
      `export function f1(args) { return Math.max(...args); }`,
      `export { x };`
    ].join("\n");

    const graph: BundleGraph = {
      a: { transformNeeded: true, tlaImports: [], importedBy: [] }
    };

    const result = transformChunk(code, parseCode(code), "a", graph, DEFAULT_OPTIONS);

    // "export" should be removed from "export function f1"
    expect(result.code).toContain("function f1(args)");
    // Should have hoisted binding
    expect(result.code).toContain("__tla_export_f1");
    expect(result.code).toContain("__tla_export_f1 = f1;");
    // Export should use binding name
    expect(result.code).toContain("__tla_export_f1 as f1");
  });

  it("should handle export default function with name", () => {
    const code = [
      `const a = await globalThis.somePromise;`,
      `export default function A(b, c, d) { return a; }`
    ].join("\n");

    const graph: BundleGraph = {
      a: { transformNeeded: true, tlaImports: [], importedBy: [] }
    };

    const result = transformChunk(code, parseCode(code), "a", graph, DEFAULT_OPTIONS);

    expect(result.code).toContain("function A(b, c, d)");
    expect(result.code).toContain("__tla_export_A");
    expect(result.code).toContain("as default");
  });

  it("should handle export default function without name", () => {
    const code = [
      `const a = await globalThis.somePromise;`,
      `export default function (b, c, d) { return a; }`
    ].join("\n");

    const graph: BundleGraph = {
      a: { transformNeeded: true, tlaImports: [], importedBy: [] }
    };

    const result = transformChunk(code, parseCode(code), "a", graph, DEFAULT_OPTIONS);

    expect(result.code).toContain("__tla_default_");
    expect(result.code).toContain("as default");
  });

  it("should handle export default expression", () => {
    const code = [
      `const a = await globalThis.somePromise;`,
      `export default globalThis.someFunc().someProp + "qwq";`
    ].join("\n");

    const graph: BundleGraph = {
      a: { transformNeeded: true, tlaImports: [], importedBy: [] }
    };

    const result = transformChunk(code, parseCode(code), "a", graph, DEFAULT_OPTIONS);

    expect(result.code).toContain("__tla_default_");
    expect(result.code).toContain("as default");
    expect(result.code).not.toContain("export default");
  });

  it("should transform dynamic imports correctly", () => {
    const code = [
      `const x = await Promise.all([`,
      `  import("./b"),`,
      `  import("./c"),`,
      `  import(globalThis.dynamicModuleName)`,
      `]);`,
      `export { x as y };`
    ].join("\n");

    const graph: BundleGraph = {
      a: { transformNeeded: true, tlaImports: [], importedBy: [] },
      b: { transformNeeded: false, tlaImports: [], importedBy: [] },
      c: { transformNeeded: true, tlaImports: [], importedBy: [] }
    };

    const result = transformChunk(code, parseCode(code), "a", graph, DEFAULT_OPTIONS);

    // import("./b") should NOT be wrapped (module b doesn't need transform)
    // import("./c") should be wrapped
    // import(dynamic) should be wrapped
    expect(result.code).toContain(`import("./c").then(async m => { await m.__tla; return m; })`);
    expect(result.code).toContain(`import(globalThis.dynamicModuleName).then(async m => { await m.__tla; return m; })`);
    // Check ./b is NOT wrapped
    expect(result.code).not.toContain(`import("./b").then`);
  });

  it("should handle side-effect-only imports", () => {
    const code = [
      `import "./b";`,
      `const x = 1;`,
      `export { x };`
    ].join("\n");

    const graph: BundleGraph = {
      a: { transformNeeded: true, tlaImports: ["b"], importedBy: [] },
      b: { transformNeeded: true, tlaImports: [], importedBy: ["a"] }
    };

    const result = transformChunk(code, parseCode(code), "a", graph, DEFAULT_OPTIONS);

    expect(result.code).toContain("__tla as __tla_0");
    expect(result.code).toContain("from");
  });

  it("should handle export-from statements", () => {
    const code = [
      `import { qwq } from "./b";`,
      `export { owo as uwu } from "./b";`,
      `const qaq = await globalThis.someFunc(qwq);`,
      `export { qaq };`
    ].join("\n");

    const graph: BundleGraph = {
      a: { transformNeeded: true, tlaImports: ["b"], importedBy: [] },
      b: { transformNeeded: true, tlaImports: [], importedBy: ["a"] }
    };

    const result = transformChunk(code, parseCode(code), "a", graph, DEFAULT_OPTIONS);

    // Should add TLA import for the regular import
    expect(result.code).toContain("__tla as __tla_0");
    // Should add a new import for the export-from
    expect(result.code).toContain("__tla as __tla_1");
    // Export-from should remain
    expect(result.code).toContain(`export { owo as uwu } from "./b"`);
  });

  it("should skip external module imports", () => {
    const code = [
      `import React from "react";`,
      `import path from "path";`,
      `const x = await globalThis.someFunc(React, path);`,
      `export { x as y };`
    ].join("\n");

    const graph: BundleGraph = {
      a: { transformNeeded: true, tlaImports: [], importedBy: [] }
    };

    const result = transformChunk(code, parseCode(code), "a", graph, DEFAULT_OPTIONS);

    // External imports should NOT get __tla specifier
    expect(result.code).not.toContain("__tla as __tla");
    // But the module should still be wrapped
    expect(result.code).toContain("(async () => {");
  });

  it("should export __tla when module has importers", () => {
    const code = `await globalThis.somePromise;\n`;
    const graph: BundleGraph = {
      a: { transformNeeded: true, tlaImports: [], importedBy: ["b"] }
    };

    const result = transformChunk(code, parseCode(code), "a", graph, DEFAULT_OPTIONS);

    expect(result.code).toContain("let __tla =");
    expect(result.code).toContain("export {");
    expect(result.code).toContain("__tla");
  });

  it("should generate sourcemap", () => {
    const code = `await globalThis.somePromise;\n`;
    const graph: BundleGraph = {
      a: { transformNeeded: true, tlaImports: [], importedBy: [] }
    };

    const ast = parseCode(code);
    const result = transformChunk(code, ast, "a", graph, DEFAULT_OPTIONS);

    expect(result.map).toBeDefined();
    expect(result.map.mappings).toBeTruthy();
  });

  it("should handle variable destructuring with exports", () => {
    const code = [
      `const { x, y } = await globalThis.somePromise;`,
      `export { x };`
    ].join("\n");

    const graph: BundleGraph = {
      a: { transformNeeded: true, tlaImports: [], importedBy: [] }
    };

    const result = transformChunk(code, parseCode(code), "a", graph, DEFAULT_OPTIONS);

    expect(result.code).toContain("let x;");
    expect(result.code).toContain("__tla");
    // Should produce valid JS
    expect(() => parseCode(result.code)).not.toThrow();
  });

  // --- Edge case tests ---

  it("should produce valid JS for object destructuring (all exported)", () => {
    const code = [
      `const { a, b } = await globalThis.somePromise;`,
      `export { a, b };`
    ].join("\n");

    const graph: BundleGraph = {
      m: { transformNeeded: true, tlaImports: [], importedBy: [] }
    };

    const result = transformChunk(code, parseCode(code), "m", graph, DEFAULT_OPTIONS);
    // Must produce valid JS (destructuring assignment needs parens)
    expect(() => parseCode(result.code)).not.toThrow();
    expect(result.code).toContain("let a, b;");
    // Should contain assignment, not declaration
    expect(normalize(result.code)).toContain("({ a, b } = await globalThis.somePromise");
  });

  it("should produce valid JS for array destructuring", () => {
    const code = [
      `const [x, y, ...z] = await globalThis.somePromise;`,
      `export { x, y };`
    ].join("\n");

    const graph: BundleGraph = {
      m: { transformNeeded: true, tlaImports: [], importedBy: [] }
    };

    const result = transformChunk(code, parseCode(code), "m", graph, DEFAULT_OPTIONS);
    expect(() => parseCode(result.code)).not.toThrow();
    expect(result.code).toContain("let x, y;");
  });

  it("should produce valid JS for mixed exported/unexported destructuring", () => {
    const code = [
      `const { x, y, z } = await globalThis.somePromise;`,
      `export { x, z as zzz };`
    ].join("\n");

    const graph: BundleGraph = {
      m: { transformNeeded: true, tlaImports: [], importedBy: [] }
    };

    const result = transformChunk(code, parseCode(code), "m", graph, DEFAULT_OPTIONS);
    expect(() => parseCode(result.code)).not.toThrow();
    // x and z are exported (hoisted), y stays in IIFE
    expect(result.code).toContain("let x, z;");
    expect(result.code).toContain("let y;");
  });

  it("should handle export class with hoisting", () => {
    const code = [
      `const x = await globalThis.somePromise;`,
      `export class C0 { method0() { return 0; } }`,
      `class C1 extends C0 { method1() { return 1; } }`,
      `export { x, C1 as Class1 };`
    ].join("\n");

    const graph: BundleGraph = {
      a: { transformNeeded: true, tlaImports: [], importedBy: [] }
    };

    const result = transformChunk(code, parseCode(code), "a", graph, DEFAULT_OPTIONS);
    expect(() => parseCode(result.code)).not.toThrow();
    expect(result.code).toContain("__tla_export_C0");
    expect(result.code).toContain("__tla_export_C0 = C0;");
    expect(result.code).toContain("__tla_export_C1");
    expect(result.code).toContain("__tla_export_C1 = C1;");
  });

  it("should handle export default class with name", () => {
    const code = [
      `const a = await globalThis.somePromise;`,
      `export default class A { prop = "qwq"; }`
    ].join("\n");

    const graph: BundleGraph = {
      a: { transformNeeded: true, tlaImports: [], importedBy: [] }
    };

    const result = transformChunk(code, parseCode(code), "a", graph, DEFAULT_OPTIONS);
    expect(() => parseCode(result.code)).not.toThrow();
    expect(result.code).toContain("class A");
    expect(result.code).toContain("__tla_export_A");
    expect(result.code).toContain("as default");
  });

  it("should handle default and named export of same identifier", () => {
    const code = [
      `const a = await globalThis.somePromise;`,
      `export { a, a as default };`
    ].join("\n");

    const graph: BundleGraph = {
      m: { transformNeeded: true, tlaImports: [], importedBy: [] }
    };

    const result = transformChunk(code, parseCode(code), "m", graph, DEFAULT_OPTIONS);
    expect(() => parseCode(result.code)).not.toThrow();
    expect(result.code).toContain("let a;");
    expect(result.code).toContain("a as default");
    expect(result.code).toContain("__tla");
  });

  it("should handle manual re-exports", () => {
    const code = [
      `import { default as qwq } from "./b";`,
      `export { qwq };`
    ].join("\n");

    const graph: BundleGraph = {
      a: { transformNeeded: true, tlaImports: ["b"], importedBy: [] },
      b: { transformNeeded: true, tlaImports: [], importedBy: ["a"] }
    };

    const result = transformChunk(code, parseCode(code), "a", graph, DEFAULT_OPTIONS);
    expect(() => parseCode(result.code)).not.toThrow();
    expect(result.code).toContain("__tla as __tla_0");
    expect(result.code).toContain("Promise.all(");
    expect(result.code).toContain("export {");
    expect(result.code).toContain("qwq");
  });

  it("should handle export * as ns from", () => {
    const code = [
      `export * as QwQ from "./b";`,
      `const x = await globalThis.somePromise;`,
      `export { x };`
    ].join("\n");

    const graph: BundleGraph = {
      a: { transformNeeded: true, tlaImports: ["b"], importedBy: [] },
      b: { transformNeeded: true, tlaImports: [], importedBy: ["a"] }
    };

    const result = transformChunk(code, parseCode(code), "a", graph, DEFAULT_OPTIONS);
    expect(() => parseCode(result.code)).not.toThrow();
    // export * as QwQ from "./b" should remain
    expect(result.code).toContain(`export * as QwQ from "./b"`);
    // Should add TLA import for it
    expect(result.code).toContain("__tla as __tla_0");
  });

  it("should handle non-exported variable declarations (no transform)", () => {
    const code = [
      `const internal = "hello";`,
      `const x = await globalThis.somePromise;`,
      `export { x };`
    ].join("\n");

    const graph: BundleGraph = {
      m: { transformNeeded: true, tlaImports: [], importedBy: [] }
    };

    const result = transformChunk(code, parseCode(code), "m", graph, DEFAULT_OPTIONS);
    expect(() => parseCode(result.code)).not.toThrow();
    // internal should stay as const inside IIFE
    expect(result.code).toContain('const internal = "hello"');
    // x should be hoisted
    expect(result.code).toContain("let x;");
  });

  it("should handle export const declaration", () => {
    const code = [
      `export const x = await globalThis.somePromise;`,
      `export const y = 42;`
    ].join("\n");

    const graph: BundleGraph = {
      m: { transformNeeded: true, tlaImports: [], importedBy: [] }
    };

    const result = transformChunk(code, parseCode(code), "m", graph, DEFAULT_OPTIONS);
    expect(() => parseCode(result.code)).not.toThrow();
    // Both x and y are exported, so both hoisted in one declaration
    expect(result.code).toMatch(/let\s+.*x/);
    expect(result.code).toMatch(/let\s+.*y/);
    expect(result.code).toContain("__tla");
    // export keyword should be removed
    expect(result.code).not.toContain("export const");
  });

  it("should handle module with only dynamic imports (no TLA)", () => {
    const code = [
      `const m = import("./lazy");`,
      `export { m };`
    ].join("\n");

    const graph: BundleGraph = {
      a: { transformNeeded: true, tlaImports: [], importedBy: [] },
      lazy: { transformNeeded: true, tlaImports: [], importedBy: [] }
    };

    const result = transformChunk(code, parseCode(code), "a", graph, DEFAULT_OPTIONS);
    expect(() => parseCode(result.code)).not.toThrow();
    expect(result.code).toContain(".then(async m =>");
  });

  it("should handle empty body with only re-exports from TLA module", () => {
    const code = [
      `export { foo, bar } from "./b";`
    ].join("\n");

    const graph: BundleGraph = {
      a: { transformNeeded: true, tlaImports: ["b"], importedBy: ["c"] },
      b: { transformNeeded: true, tlaImports: [], importedBy: ["a"] }
    };

    const result = transformChunk(code, parseCode(code), "a", graph, DEFAULT_OPTIONS);
    expect(() => parseCode(result.code)).not.toThrow();
    // Should still create __tla promise and export it
    expect(result.code).toContain("__tla");
    expect(result.code).toContain("export {");
  });

  // --- Regression: pre-import body statements (e.g. Sentry debug-id IIFE) ---

  it("should not wrap import declarations inside IIFE when a plugin injects code before imports", () => {
    // @sentry/vite-plugin (and similar tools) prepend a synchronous IIFE to chunks
    // BEFORE the static import declarations.  Previously the IIFE insertion point
    // was bodyStmts[0].start = 0, so imports at positions > 0 ended up inside the
    // async wrapper — producing invalid ESM ("import" declarations inside a function).
    const sentryIife = `!function(){try{var e=globalThis;e._sentryDebugIds=e._sentryDebugIds||{},e._sentryDebugIds["stack"]="test-debug-id"}catch(e){}}();`;
    const code = [
      sentryIife,
      `import { foo } from "./b";`,
      `import "./c";`,
      `const result = foo + 1;`,
      `export { result };`
    ].join("\n");

    const graph: BundleGraph = {
      a: { transformNeeded: true, tlaImports: ["b", "c"], importedBy: [] },
      b: { transformNeeded: true, tlaImports: [], importedBy: ["a"] },
      c: { transformNeeded: true, tlaImports: [], importedBy: ["a"] }
    };

    const result = transformChunk(code, parseCode(code), "a", graph, DEFAULT_OPTIONS);

    // Must be parseable — import declarations must NOT be inside the async function
    expect(() => parseCode(result.code)).not.toThrow();

    // The Sentry IIFE must be present and at the top level (not moved or removed)
    expect(result.code).toContain("_sentryDebugIds");

    // Both imports must have __tla specifiers added
    expect(result.code).toContain("__tla as __tla_0");
    expect(result.code).toContain("__tla as __tla_1");

    // The async IIFE wrapper must wrap only the body (not the imports)
    expect(result.code).toContain("Promise.all(");

    // Sanity: result and __tla are exported
    expect(result.code).toContain("let result;");
    expect(result.code).toContain("export {");
    expect(result.code).toContain("__tla");
  });

  it("should keep pre-import IIFE outside the async wrapper when there are no TLA imports", () => {
    // Same scenario but the imported modules don't need TLA transform.
    // The chunk itself has TLA; the pre-import IIFE must still stay outside.
    const sentryIife = `!function(){try{globalThis.__dbg="id"}catch(e){}}();`;
    const code = [
      sentryIife,
      `import { helper } from "./utils";`,
      `const data = await fetch("/api");`,
      `export { data };`
    ].join("\n");

    const graph: BundleGraph = {
      a: { transformNeeded: true, tlaImports: [], importedBy: [] },
      utils: { transformNeeded: false, tlaImports: [], importedBy: ["a"] }
    };

    const result = transformChunk(code, parseCode(code), "a", graph, DEFAULT_OPTIONS);

    expect(() => parseCode(result.code)).not.toThrow();
    expect(result.code).toContain("__dbg");
    expect(result.code).toContain("await fetch");
    expect(result.code).toContain("let data;");
  });

  it("gracefully handles missing chunk in graph", () => {
    const code = `await globalThis.someFunc(import("./unknown.js"));\n`;
    const graph: BundleGraph = {};

    const result = transformChunk(code, parseCode(code), "css-module.js", graph, DEFAULT_OPTIONS);
    expect(() => parseCode(result.code)).not.toThrow();
    expect(result.code).toContain("(async () => {");
  });

  // --- Regression: import specifier wrapping ---

  it("should wrap __tla in braces when appending to a default import", () => {
    // Bug: `import foo, __tla as __tla_0 from './b'` is invalid ESM syntax.
    // Must produce: `import foo, { __tla as __tla_0 } from './b'`
    const code = `import foo from "./b";\nawait globalThis.somePromise;\n`;
    const graph: BundleGraph = {
      a: { transformNeeded: true, tlaImports: ["b"], importedBy: [] },
      b: { transformNeeded: true, tlaImports: [], importedBy: ["a"] }
    };

    const result = transformChunk(code, parseCode(code), "a", graph, DEFAULT_OPTIONS);

    expect(() => parseCode(result.code)).not.toThrow();
    expect(result.code).toContain(`import foo, { __tla as __tla_0 } from "./b"`);
  });

  it("should insert a separate import for namespace imports (ESM forbids namespace + named in one clause)", () => {
    // `import * as ns, { foo } from './b'` is invalid ESM — namespace and named imports
    // cannot coexist in the same import clause. Must produce a separate import statement.
    const code = `import * as ns from "./b";\nawait globalThis.somePromise;\n`;
    const graph: BundleGraph = {
      a: { transformNeeded: true, tlaImports: ["b"], importedBy: [] },
      b: { transformNeeded: true, tlaImports: [], importedBy: ["a"] }
    };

    const result = transformChunk(code, parseCode(code), "a", graph, DEFAULT_OPTIONS);

    expect(() => parseCode(result.code)).not.toThrow();
    // The namespace import must be left intact
    expect(result.code).toContain(`import * as ns from "./b"`);
    // __tla must be imported via a separate statement
    expect(result.code).toContain(`import { __tla as __tla_0 } from "./b"`);
  });

  it("should insert a separate import for default + namespace import", () => {
    // `import foo, * as ns` — last specifier is namespace, same constraint applies.
    const code = `import foo, * as ns from "./b";\nawait globalThis.somePromise;\n`;
    const graph: BundleGraph = {
      a: { transformNeeded: true, tlaImports: ["b"], importedBy: [] },
      b: { transformNeeded: true, tlaImports: [], importedBy: ["a"] }
    };

    const result = transformChunk(code, parseCode(code), "a", graph, DEFAULT_OPTIONS);

    expect(() => parseCode(result.code)).not.toThrow();
    expect(result.code).toContain(`import foo, * as ns from "./b"`);
    expect(result.code).toContain(`import { __tla as __tla_0 } from "./b"`);
  });

  // --- Regression: multi-declarator var with mixed exported/non-exported names ---

  it("should declare non-exported names with let when var is removed from multi-declarator statement", () => {
    // Bug: `var exported = f(exported || {}), nonExported = g(nonExported || {})`
    // When 'exported' is exported, plugin removes 'var ', but 'nonExported' loses its
    // declaration entirely → ReferenceError in strict-mode ESM.
    const code = [
      `var Exported = ((t) => (t.A = "a", t))(Exported || {}), NonExported = ((t) => (t.B = "b", t))(NonExported || {});`,
      `export { Exported };`
    ].join("\n");
    const graph: BundleGraph = {
      m: { transformNeeded: true, tlaImports: [], importedBy: [] }
    };

    const result = transformChunk(code, parseCode(code), "m", graph, DEFAULT_OPTIONS);

    expect(() => parseCode(result.code)).not.toThrow();
    // NonExported must be declared with let inside the IIFE
    expect(result.code).toContain("let NonExported");
    // Exported is hoisted outside the IIFE
    expect(result.code).toContain("let Exported");
    // var keyword must be gone
    expect(result.code).not.toContain("var Exported");
  });

  it("should not call s.remove twice when multiple declarators are exported in same var statement", () => {
    // Bug: the loop called s.remove() on the same range once per exported declarator,
    // causing a MagicString crash on the second call.
    const code = [
      `var A = ((t) => (t.X = "x", t))(A || {}), B = ((t) => (t.Y = "y", t))(B || {});`,
      `export { A, B };`
    ].join("\n");
    const graph: BundleGraph = {
      m: { transformNeeded: true, tlaImports: [], importedBy: [] }
    };

    // Must not throw (previously crashed with a MagicString split-range error)
    expect(() => {
      const result = transformChunk(code, parseCode(code), "m", graph, DEFAULT_OPTIONS);
      parseCode(result.code);
    }).not.toThrow();
  });

  // --- Propagated transform (no local TLA, imports TLA module) ---

  it("should transform module with no local TLA that imports a TLA module", () => {
    const code = [
      `import { value } from "./b";`,
      `const doubled = value * 2;`,
      `export { doubled };`
    ].join("\n");

    const graph: BundleGraph = {
      a: { transformNeeded: true, tlaImports: ["b"], importedBy: [] },
      b: { transformNeeded: true, tlaImports: [], importedBy: ["a"] }
    };

    const result = transformChunk(code, parseCode(code), "a", graph, DEFAULT_OPTIONS);
    expect(() => parseCode(result.code)).not.toThrow();
    expect(result.code).toContain("__tla as __tla_0");
    expect(result.code).toContain("Promise.all(");
    expect(result.code).toContain("let doubled;");
    expect(result.code).toContain("export {");
  });

  it("should transform module with both local TLA and TLA imports", () => {
    const code = [
      `import { dep } from "./b";`,
      `const x = await fetch("/api");`,
      `const y = dep + x;`,
      `export { y };`
    ].join("\n");

    const graph: BundleGraph = {
      a: { transformNeeded: true, tlaImports: ["b"], importedBy: [] },
      b: { transformNeeded: true, tlaImports: [], importedBy: ["a"] }
    };

    const result = transformChunk(code, parseCode(code), "a", graph, DEFAULT_OPTIONS);
    expect(() => parseCode(result.code)).not.toThrow();
    expect(result.code).toContain("__tla as __tla_0");
    expect(result.code).toContain("Promise.all(");
    expect(result.code).toContain("await fetch");
    expect(result.code).toContain("let y;");
  });

  // --- Import specifier combinations ---

  it("should append __tla to default + named import", () => {
    const code = `import foo, { bar } from "./b";\nawait globalThis.somePromise;\n`;
    const graph: BundleGraph = {
      a: { transformNeeded: true, tlaImports: ["b"], importedBy: [] },
      b: { transformNeeded: true, tlaImports: [], importedBy: ["a"] }
    };

    const result = transformChunk(code, parseCode(code), "a", graph, DEFAULT_OPTIONS);
    expect(() => parseCode(result.code)).not.toThrow();
    // Last specifier is ImportSpecifier(bar), so __tla appends inside existing braces
    expect(result.code).toContain("import foo, { bar, __tla as __tla_0 } from");
  });

  it("should append __tla to multiple named imports", () => {
    const code = `import { a, b, c } from "./b";\nawait globalThis.somePromise;\n`;
    const graph: BundleGraph = {
      a: { transformNeeded: true, tlaImports: ["b"], importedBy: [] },
      b: { transformNeeded: true, tlaImports: [], importedBy: ["a"] }
    };

    const result = transformChunk(code, parseCode(code), "a", graph, DEFAULT_OPTIONS);
    expect(() => parseCode(result.code)).not.toThrow();
    expect(result.code).toContain("{ a, b, c, __tla as __tla_0 }");
  });

  // --- Export patterns ---

  it("should handle export * from (re-export all without alias)", () => {
    const code = [
      `export * from "./b";`,
      `const x = await globalThis.somePromise;`,
      `export { x };`
    ].join("\n");

    const graph: BundleGraph = {
      a: { transformNeeded: true, tlaImports: ["b"], importedBy: [] },
      b: { transformNeeded: true, tlaImports: [], importedBy: ["a"] }
    };

    const result = transformChunk(code, parseCode(code), "a", graph, DEFAULT_OPTIONS);
    expect(() => parseCode(result.code)).not.toThrow();
    // export * should remain untouched
    expect(result.code).toContain(`export * from "./b"`);
    // Should add TLA import for it
    expect(result.code).toContain("__tla as __tla_0");
  });

  it("should handle export default class without name", () => {
    const code = [
      `const a = await globalThis.somePromise;`,
      `export default class { method() { return a; } }`
    ].join("\n");

    const graph: BundleGraph = {
      a: { transformNeeded: true, tlaImports: [], importedBy: [] }
    };

    const result = transformChunk(code, parseCode(code), "a", graph, DEFAULT_OPTIONS);
    expect(() => parseCode(result.code)).not.toThrow();
    expect(result.code).toContain("__tla_default_");
    expect(result.code).toContain("as default");
    expect(result.code).not.toContain("export default");
  });

  it("should handle export let declaration", () => {
    const code = [
      `export let x = await globalThis.somePromise;`,
      `export let y = 42;`
    ].join("\n");

    const graph: BundleGraph = {
      m: { transformNeeded: true, tlaImports: [], importedBy: [] }
    };

    const result = transformChunk(code, parseCode(code), "m", graph, DEFAULT_OPTIONS);
    expect(() => parseCode(result.code)).not.toThrow();
    expect(result.code).not.toContain("export let");
    expect(result.code).toContain("__tla");
    expect(result.code).toMatch(/let\s+.*x/);
    expect(result.code).toMatch(/let\s+.*y/);
  });

  it("should handle export var declaration (single declarator)", () => {
    const code = [
      `export var x = await globalThis.somePromise;`
    ].join("\n");

    const graph: BundleGraph = {
      m: { transformNeeded: true, tlaImports: [], importedBy: [] }
    };

    const result = transformChunk(code, parseCode(code), "m", graph, DEFAULT_OPTIONS);
    expect(() => parseCode(result.code)).not.toThrow();
    expect(result.code).not.toContain("export var");
    expect(result.code).toContain("__tla");
  });

  // --- Destructuring edge cases ---

  it("should handle nested object destructuring with exports", () => {
    const code = [
      `const { a: { b, c }, d } = await globalThis.somePromise;`,
      `export { b, d };`
    ].join("\n");

    const graph: BundleGraph = {
      m: { transformNeeded: true, tlaImports: [], importedBy: [] }
    };

    const result = transformChunk(code, parseCode(code), "m", graph, DEFAULT_OPTIONS);
    expect(() => parseCode(result.code)).not.toThrow();
    expect(result.code).toContain("let b, d;");
    // c is unexported, should be declared inside IIFE
    expect(result.code).toContain("let c;");
  });

  it("should handle destructuring with default values and exports", () => {
    const code = [
      `const { a = 1, b = 2, c = 3 } = await globalThis.somePromise;`,
      `export { a, c };`
    ].join("\n");

    const graph: BundleGraph = {
      m: { transformNeeded: true, tlaImports: [], importedBy: [] }
    };

    const result = transformChunk(code, parseCode(code), "m", graph, DEFAULT_OPTIONS);
    expect(() => parseCode(result.code)).not.toThrow();
    expect(result.code).toContain("let a, c;");
    expect(result.code).toContain("let b;");
  });

  it("should handle rest element in object destructuring with exports", () => {
    const code = [
      `const { a, ...rest } = await globalThis.somePromise;`,
      `export { a, rest };`
    ].join("\n");

    const graph: BundleGraph = {
      m: { transformNeeded: true, tlaImports: [], importedBy: [] }
    };

    const result = transformChunk(code, parseCode(code), "m", graph, DEFAULT_OPTIONS);
    expect(() => parseCode(result.code)).not.toThrow();
    expect(result.code).toContain("let a, rest;");
  });

  it("should handle rest element in array destructuring with exports", () => {
    const code = [
      `const [first, ...others] = await globalThis.somePromise;`,
      `export { first };`
    ].join("\n");

    const graph: BundleGraph = {
      m: { transformNeeded: true, tlaImports: [], importedBy: [] }
    };

    const result = transformChunk(code, parseCode(code), "m", graph, DEFAULT_OPTIONS);
    expect(() => parseCode(result.code)).not.toThrow();
    expect(result.code).toContain("let first;");
    // others is not exported, declared inside IIFE
    expect(result.code).toContain("let others;");
  });

  // --- Dynamic import edge cases ---

  it("should wrap dynamic import inside a function body", () => {
    const code = [
      `function load(name) { return import("./" + name); }`,
      `export { load };`
    ].join("\n");

    const graph: BundleGraph = {
      a: { transformNeeded: true, tlaImports: [], importedBy: ["b"] }
    };

    const result = transformChunk(code, parseCode(code), "a", graph, DEFAULT_OPTIONS);
    expect(() => parseCode(result.code)).not.toThrow();
    // Dynamic import with non-literal arg should be wrapped
    expect(result.code).toContain('.then(async m => { await m.__tla; return m; })');
  });

  // --- Multiple TLA imports from different sources ---

  it("should handle three TLA imports with correct promise indices", () => {
    const code = [
      `import { a } from "./x";`,
      `import { b } from "./y";`,
      `import { c } from "./z";`,
      `const result = await compute(a, b, c);`,
      `export { result };`
    ].join("\n");

    const graph: BundleGraph = {
      m: { transformNeeded: true, tlaImports: ["x", "y", "z"], importedBy: [] },
      x: { transformNeeded: true, tlaImports: [], importedBy: ["m"] },
      y: { transformNeeded: true, tlaImports: [], importedBy: ["m"] },
      z: { transformNeeded: true, tlaImports: [], importedBy: ["m"] }
    };

    const result = transformChunk(code, parseCode(code), "m", graph, DEFAULT_OPTIONS);
    expect(() => parseCode(result.code)).not.toThrow();
    expect(result.code).toContain("__tla_0");
    expect(result.code).toContain("__tla_1");
    expect(result.code).toContain("__tla_2");
    expect(result.code).toContain("Promise.all(");
  });

  // --- Only re-exports, no body, no TLA ---

  it("should handle pure re-export module that needs transform due to propagation", () => {
    const code = [
      `import { foo } from "./b";`,
      `export { foo };`
    ].join("\n");

    const graph: BundleGraph = {
      a: { transformNeeded: true, tlaImports: ["b"], importedBy: ["c"] },
      b: { transformNeeded: true, tlaImports: [], importedBy: ["a"] }
    };

    const result = transformChunk(code, parseCode(code), "a", graph, DEFAULT_OPTIONS);
    expect(() => parseCode(result.code)).not.toThrow();
    expect(result.code).toContain("__tla as __tla_0");
    expect(result.code).toContain("Promise.all(");
    expect(result.code).toContain("export {");
    expect(result.code).toContain("__tla");
  });

  it("should handle three-declarator var where only middle one is exported", () => {
    const code = [
      `var A = ((t) => (t.X = "x", t))(A || {}), B = ((t) => (t.Y = "y", t))(B || {}), C = ((t) => (t.Z = "z", t))(C || {});`,
      `export { B };`
    ].join("\n");
    const graph: BundleGraph = {
      m: { transformNeeded: true, tlaImports: [], importedBy: [] }
    };

    const result = transformChunk(code, parseCode(code), "m", graph, DEFAULT_OPTIONS);

    expect(() => parseCode(result.code)).not.toThrow();
    // A and C must be declared with let together (non-exported, lose var)
    expect(result.code).toContain("let A, C");
    // B is hoisted outside the IIFE
    expect(result.code).toContain("let B");
    expect(result.code).not.toContain("var ");
  });
});
