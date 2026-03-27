import { buildBundleGraph } from "./analyze";
import type { ChunkAnalysis } from "./types";
import type { RenderedChunk } from "rollup";

function makeChunk(imports: string[], exports: string[] = []): RenderedChunk {
  return {
    imports,
    exports,
    fileName: "",
    dynamicImports: [],
    modules: {},
    facadeModuleId: null,
    isDynamicEntry: false,
    isEntry: false,
    isImplicitEntry: false,
    moduleIds: [],
    name: "",
    type: "chunk",
    importedBindings: {},
    referencedFiles: [],
    preliminaryFileName: "",
    sourcemapFileName: null,
    implicitlyLoadedBefore: []
  } as unknown as RenderedChunk;
}

function makeAnalysis(hasTLA: boolean, hasDynamicImport: boolean = false): ChunkAnalysis {
  return { hasTLA, hasDynamicImport, ast: null as any, code: "" };
}

describe("buildBundleGraph", () => {
  it("should mark TLA chunks as needing transform", () => {
    const analysis = new Map<string, ChunkAnalysis>();
    analysis.set("a.js", makeAnalysis(true));
    analysis.set("b.js", makeAnalysis(false));

    const chunks: Record<string, RenderedChunk> = {
      "a.js": makeChunk([]),
      "b.js": makeChunk([])
    };

    const graph = buildBundleGraph(analysis, chunks);
    expect(graph["a.js"].transformNeeded).toBe(true);
    expect(graph["b.js"].transformNeeded).toBe(false);
  });

  it("should propagate transformNeeded to importers", () => {
    const analysis = new Map<string, ChunkAnalysis>();
    analysis.set("a.js", makeAnalysis(true));
    analysis.set("b.js", makeAnalysis(false));
    analysis.set("c.js", makeAnalysis(false));

    const chunks: Record<string, RenderedChunk> = {
      "a.js": makeChunk([]),
      "b.js": makeChunk(["a.js"]),      // b imports a (which has TLA)
      "c.js": makeChunk(["b.js"])        // c imports b
    };

    const graph = buildBundleGraph(analysis, chunks);
    expect(graph["a.js"].transformNeeded).toBe(true);
    expect(graph["b.js"].transformNeeded).toBe(true);
    expect(graph["c.js"].transformNeeded).toBe(true);
  });

  it("should not propagate to unrelated chunks", () => {
    const analysis = new Map<string, ChunkAnalysis>();
    analysis.set("a.js", makeAnalysis(true));
    analysis.set("b.js", makeAnalysis(false));
    analysis.set("c.js", makeAnalysis(false));

    const chunks: Record<string, RenderedChunk> = {
      "a.js": makeChunk([]),
      "b.js": makeChunk(["a.js"]),
      "c.js": makeChunk([])              // c is independent
    };

    const graph = buildBundleGraph(analysis, chunks);
    expect(graph["c.js"].transformNeeded).toBe(false);
  });

  it("should populate tlaImports correctly", () => {
    const analysis = new Map<string, ChunkAnalysis>();
    analysis.set("a.js", makeAnalysis(true));
    analysis.set("b.js", makeAnalysis(false));
    analysis.set("c.js", makeAnalysis(false));

    const chunks: Record<string, RenderedChunk> = {
      "a.js": makeChunk([]),
      "b.js": makeChunk(["a.js"]),
      "c.js": makeChunk(["a.js", "b.js"])
    };

    const graph = buildBundleGraph(analysis, chunks);
    expect(graph["c.js"].tlaImports).toEqual(["a.js", "b.js"]);
    expect(graph["b.js"].tlaImports).toEqual(["a.js"]);
    expect(graph["a.js"].tlaImports).toEqual([]);
  });

  it("should mark dynamic import chunks as needing transform", () => {
    const analysis = new Map<string, ChunkAnalysis>();
    analysis.set("a.js", makeAnalysis(false, true));
    analysis.set("b.js", makeAnalysis(false));

    const chunks: Record<string, RenderedChunk> = {
      "a.js": makeChunk([]),
      "b.js": makeChunk([])
    };

    const graph = buildBundleGraph(analysis, chunks);
    expect(graph["a.js"].transformNeeded).toBe(true);
    expect(graph["b.js"].transformNeeded).toBe(false);
  });
});
