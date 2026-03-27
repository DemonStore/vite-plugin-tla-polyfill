import { parse } from "acorn";
import { SourceMapConsumer } from "source-map";
import { transformChunk } from "./transform";
import type { BundleGraph } from "./types";
import { DEFAULT_OPTIONS } from "./types";

function parseCode(code: string) {
  return parse(code, { ecmaVersion: 2022, sourceType: "module" }) as any;
}

async function getConsumer(map: any): Promise<SourceMapConsumer> {
  const rawMap = typeof map.toString === "function"
    ? JSON.parse(map.toString())
    : map;
  return new SourceMapConsumer(rawMap);
}

const simpleGraph: BundleGraph = {
  "mod.js": { transformNeeded: true, tlaImports: [], importedBy: [] }
};

describe("sourcemap validation", () => {
  it("should produce a valid sourcemap", async () => {
    const code = [
      `const x = await Promise.resolve(42);`,
      `export { x };`
    ].join("\n");

    const ast = parseCode(code);
    const result = transformChunk(code, ast, "mod.js", simpleGraph, DEFAULT_OPTIONS);

    expect(result.map).toBeDefined();
    const raw = typeof result.map.toString === "function"
      ? JSON.parse(result.map.toString())
      : result.map;
    expect(raw.mappings).toBeTruthy();
    expect(raw.sources).toBeDefined();
  });

  it("should map original identifiers correctly", async () => {
    const code = [
      `const value = await Promise.resolve(99);`,
      `export { value };`
    ].join("\n");

    const ast = parseCode(code);
    const result = transformChunk(code, ast, "mod.js", simpleGraph, DEFAULT_OPTIONS);

    const consumer = await getConsumer(result.map);

    // Find "value" in the output code
    const outputLines = result.code.split("\n");
    let foundMapping = false;
    for (let line = 0; line < outputLines.length; line++) {
      const col = outputLines[line].indexOf("value");
      if (col === -1) continue;
      const pos = consumer.originalPositionFor({ line: line + 1, column: col });
      if (pos.line !== null) {
        // The mapping should point back to somewhere in the original code
        expect(pos.line).toBeGreaterThan(0);
        foundMapping = true;
        break;
      }
    }
    expect(foundMapping).toBe(true);
    (consumer as any).destroy?.();
  });

  it("should not map IIFE wrapper to original source", async () => {
    const code = `const x = await Promise.resolve(1);\nexport { x };\n`;

    const ast = parseCode(code);
    const result = transformChunk(code, ast, "mod.js", simpleGraph, DEFAULT_OPTIONS);

    const consumer = await getConsumer(result.map);
    const outputLines = result.code.split("\n");

    // Find the "(async () => {" line — it's generated code, shouldn't map to original
    for (let line = 0; line < outputLines.length; line++) {
      if (outputLines[line].includes("async ()") || outputLines[line].includes("Promise.all")) {
        const pos = consumer.originalPositionFor({ line: line + 1, column: 0 });
        // Generated wrapper lines have null or empty mappings
        expect(pos.line === null || pos.source === null).toBe(true);
        break;
      }
    }
    (consumer as any).destroy?.();
  });

  it("should preserve sourcemap across import specifier addition", async () => {
    const code = [
      `import { qwq } from "./b.js";`,
      `const x = await qwq;`,
      `export { x };`
    ].join("\n");

    const graph: BundleGraph = {
      "a.js": { transformNeeded: true, tlaImports: ["b.js"], importedBy: [] },
      "b.js": { transformNeeded: true, tlaImports: [], importedBy: ["a.js"] }
    };

    const ast = parseCode(code);
    const result = transformChunk(code, ast, "a.js", graph, DEFAULT_OPTIONS);

    const consumer = await getConsumer(result.map);
    const outputLines = result.code.split("\n");

    // "qwq" identifier should still map to original source
    let found = false;
    for (let line = 0; line < outputLines.length; line++) {
      const col = outputLines[line].indexOf("qwq");
      if (col === -1) continue;
      // Skip the import specifier qwq that was already in original
      const pos = consumer.originalPositionFor({ line: line + 1, column: col });
      if (pos.line !== null) {
        expect(pos.line).toBeGreaterThan(0);
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
    (consumer as any).destroy?.();
  });
});

describe("hash consistency (issue #44)", () => {
  it("different TLA code produces different output content", () => {
    const codeA = `const x = await Promise.resolve(1);\nexport { x };\n`;
    const codeB = `const x = await Promise.resolve(999);\nexport { x };\n`;

    const graph: BundleGraph = {
      "mod.js": { transformNeeded: true, tlaImports: [], importedBy: [] }
    };

    const resultA = transformChunk(codeA, parseCode(codeA), "mod.js", graph, DEFAULT_OPTIONS);
    const resultB = transformChunk(codeB, parseCode(codeB), "mod.js", graph, DEFAULT_OPTIONS);

    // Content must differ — Rollup will produce different hashes from different content
    expect(resultA.code).not.toBe(resultB.code);
  });

  it("same TLA code produces identical output content (deterministic)", () => {
    const code = `const x = await Promise.resolve(42);\nexport { x };\n`;
    const graph: BundleGraph = {
      "mod.js": { transformNeeded: true, tlaImports: [], importedBy: [] }
    };

    const result1 = transformChunk(code, parseCode(code), "mod.js", graph, DEFAULT_OPTIONS);
    const result2 = transformChunk(code, parseCode(code), "mod.js", graph, DEFAULT_OPTIONS);

    expect(result1.code).toBe(result2.code);
  });

  it("transform preserves original TLA expression value", () => {
    // Ensure the actual runtime value (42) is preserved in transformed code
    const code = `const x = await Promise.resolve(42);\nexport { x };\n`;
    const graph: BundleGraph = {
      "mod.js": { transformNeeded: true, tlaImports: [], importedBy: [] }
    };

    const result = transformChunk(code, parseCode(code), "mod.js", graph, DEFAULT_OPTIONS);
    // The literal 42 must appear in the output
    expect(result.code).toContain("42");
  });
});
