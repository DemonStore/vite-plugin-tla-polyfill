import type { ChunkAnalysis, ChunkTransformInfo, BundleGraph } from "./types";
import type { RenderedChunk } from "rollup";

export function buildBundleGraph(
  analysisMap: Map<string, ChunkAnalysis>,
  metaChunks: Record<string, RenderedChunk>
): BundleGraph {
  const graph: BundleGraph = {};

  // Initialize all chunks
  for (const [fileName, chunk] of Object.entries(metaChunks)) {
    const analysis = analysisMap.get(fileName);
    graph[fileName] = {
      transformNeeded: analysis
        ? analysis.hasTLA || analysis.hasDynamicImport
        : false,
      tlaImports: [],
      importedBy: []
    };
  }

  // Build reverse edges from meta.chunks imports
  for (const [fileName, chunk] of Object.entries(metaChunks)) {
    for (const imp of chunk.imports) {
      if (graph[imp]) {
        graph[imp].importedBy.push(fileName);
      }
    }
  }

  // BFS propagation: if chunk X needs transform, all its importers do too
  const queue: string[] = Object.entries(graph)
    .filter(([, info]) => info.transformNeeded)
    .map(([name]) => name);

  let head = 0;
  while (head < queue.length) {
    const current = queue[head++];
    for (const importer of graph[current].importedBy) {
      if (!graph[importer].transformNeeded) {
        graph[importer].transformNeeded = true;
        queue.push(importer);
      }
    }
  }

  // For each chunk that needs transform, figure out which of its imports also need transform
  for (const [fileName, chunk] of Object.entries(metaChunks)) {
    if (!graph[fileName].transformNeeded) continue;
    graph[fileName].tlaImports = chunk.imports.filter(
      imp => graph[imp]?.transformNeeded
    );
  }

  return graph;
}
