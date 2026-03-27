import { rollup, OutputChunk } from "rollup";
import path from "path";
import fs from "fs";
import { parse } from "acorn";

// We test the core modules directly since they're what renderChunk calls
import { detect } from "../src/detect";
import { ChunkBarrier } from "../src/barrier";
import { buildBundleGraph } from "../src/analyze";
import { transformChunk } from "../src/transform";
import { DEFAULT_OPTIONS } from "../src/types";

const fixturesDir = path.resolve(__dirname, "fixtures");

async function buildBundle() {
  const bundle = await rollup({
    input: path.resolve(fixturesDir, "main.js")
  });

  const { output } = await bundle.generate({
    format: "es",
    dir: "dist",
    entryFileNames: "[name]-[hash].js",
    chunkFileNames: "[name]-[hash].js",
    sourcemap: true
  });

  return output.filter((item): item is OutputChunk => item.type === "chunk");
}

// Simulate what the plugin's renderChunk does: analyze all chunks, build graph, transform
async function transformBundle(chunks: OutputChunk[]) {
  const barrier = new ChunkBarrier();

  // Phase 1: Analyze all chunks
  const analyses = new Map<string, { ast: any; detection: ReturnType<typeof detect>; code: string }>();

  for (const chunk of chunks) {
    const ast = parse(chunk.code, { ecmaVersion: 2022, sourceType: "module" }) as any;
    const detection = detect(ast);
    analyses.set(chunk.fileName, { ast, detection, code: chunk.code });
    barrier.report(chunk.fileName, {
      hasTLA: detection.hasTLA,
      hasDynamicImport: detection.hasDynamicImport,
      ast,
      code: chunk.code
    }, chunks.length);
  }

  await barrier.wait();

  // Build meta.chunks equivalent from rollup output
  const metaChunks: Record<string, any> = {};
  for (const chunk of chunks) {
    metaChunks[chunk.fileName] = {
      imports: chunk.imports,
      exports: chunk.exports,
      dynamicImports: chunk.dynamicImports,
      fileName: chunk.fileName
    };
  }

  const graph = buildBundleGraph(
    new Map(chunks.map(c => [c.fileName, {
      hasTLA: analyses.get(c.fileName)!.detection.hasTLA,
      hasDynamicImport: analyses.get(c.fileName)!.detection.hasDynamicImport,
      ast: analyses.get(c.fileName)!.ast,
      code: c.code
    }])),
    metaChunks
  );

  // Phase 2: Transform
  const results: Record<string, { code: string; map: any; transformed: boolean }> = {};

  for (const chunk of chunks) {
    const info = graph[chunk.fileName];
    if (!info?.transformNeeded) {
      results[chunk.fileName] = { code: chunk.code, map: chunk.map, transformed: false };
      continue;
    }

    const { ast } = analyses.get(chunk.fileName)!;
    const result = transformChunk(chunk.code, ast, chunk.fileName, graph, DEFAULT_OPTIONS);
    results[chunk.fileName] = { code: result.code, map: result.map, transformed: true };
  }

  return { results, graph };
}

describe("E2E: Rollup build with TLA transform", () => {
  it("should detect TLA in the bundle", async () => {
    const chunks = await buildBundle();

    // Find chunk with TLA
    const hasTLA = chunks.some(chunk => {
      const ast = parse(chunk.code, { ecmaVersion: 2022, sourceType: "module" }) as any;
      return detect(ast).hasTLA;
    });

    expect(hasTLA).toBe(true);
  }, 30000);

  it("should transform TLA chunks and produce valid JS", async () => {
    const chunks = await buildBundle();
    const { results } = await transformBundle(chunks);

    let transformedCount = 0;
    for (const [fileName, result] of Object.entries(results)) {
      // Every output must be valid JS
      expect(() => {
        parse(result.code, { ecmaVersion: 2022, sourceType: "module" });
      }).not.toThrow();

      if (result.transformed) {
        transformedCount++;
        // Transformed chunks should contain __tla
        expect(result.code).toContain("__tla");
      }
    }

    expect(transformedCount).toBeGreaterThan(0);
  }, 30000);

  it("should propagate transform to importers of TLA modules", async () => {
    const chunks = await buildBundle();
    const { graph } = await transformBundle(chunks);

    // Find the entry chunk (main.js)
    const entryChunk = chunks.find(c => c.isEntry);
    expect(entryChunk).toBeDefined();

    // Entry imports a TLA module, so it should need transform too
    const entryInfo = graph[entryChunk!.fileName];
    expect(entryInfo.transformNeeded).toBe(true);
  }, 30000);

  it("should generate sourcemaps for transformed chunks", async () => {
    const chunks = await buildBundle();
    const { results } = await transformBundle(chunks);

    for (const [fileName, result] of Object.entries(results)) {
      if (result.transformed) {
        expect(result.map).toBeDefined();
        expect(result.map.mappings).toBeTruthy();
      }
    }
  }, 30000);

  it("should add __tla import specifiers for TLA dependencies", async () => {
    const chunks = await buildBundle();
    const { results } = await transformBundle(chunks);

    // Find the entry chunk that imports the TLA module
    const entryChunk = chunks.find(c => c.isEntry);
    const entryResult = results[entryChunk!.fileName];

    if (entryResult.transformed) {
      // Should have __tla import
      expect(entryResult.code).toContain("__tla");
      // Should have Promise.all or async IIFE
      expect(entryResult.code).toMatch(/Promise\.all|async\s*\(\)/);
    }
  }, 30000);

  it("should not transform non-TLA modules with no TLA imports", async () => {
    const chunks = await buildBundle();
    const { graph } = await transformBundle(chunks);

    // no-tla.js should either be inlined or not need transform if it's a separate chunk
    // with no TLA dependencies
    for (const [fileName, info] of Object.entries(graph)) {
      const chunk = chunks.find(c => c.fileName === fileName);
      if (chunk && !chunk.imports.some(imp => graph[imp]?.transformNeeded)) {
        const ast = parse(chunk.code, { ecmaVersion: 2022, sourceType: "module" }) as any;
        const detection = detect(ast);
        if (!detection.hasTLA && !detection.hasDynamicImport) {
          expect(info.transformNeeded).toBe(false);
        }
      }
    }
  }, 30000);
});
