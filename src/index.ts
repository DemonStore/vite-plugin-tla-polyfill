import { Plugin, ResolvedConfig } from "vite";
import { OutputChunk } from "rollup";
import { parse } from "acorn";
import remapping from "@ampproject/remapping";

import { Options, DEFAULT_OPTIONS } from "./types";
import { detect } from "./detect";
import { ChunkBarrier } from "./barrier";
import { buildBundleGraph } from "./analyze";
import { transformChunk } from "./transform";
import { convertWorkerToIife } from "./worker-iife";
import esbuild from "./esbuild";

export type { Options } from "./types";

type ViteTarget = ResolvedConfig["build"]["target"];

const DEFAULT_VITE_TARGET: ViteTarget = ["es2020", "edge88", "firefox78", "chrome87", "safari14"];

export default function topLevelAwait(options?: Options): Plugin {
  const resolvedOptions: Required<Options> = {
    ...DEFAULT_OPTIONS,
    ...(options || {})
  };

  let isWorker = false;
  let isWorkerIifeRequested = false;

  let assetsDir = "";
  let buildTarget: ViteTarget;
  let minify: boolean;

  let barrier: ChunkBarrier;

  const buildRawTarget = async (code: string) => {
    return (
      await esbuild.transform(code, {
        minify,
        target: buildTarget as string | string[],
        format: "esm"
      })
    ).code as string;
  };

  return {
    name: "vite-plugin-top-level-await",
    enforce: "post",

    buildStart() {
      barrier = new ChunkBarrier();
    },

    outputOptions(options) {
      if (isWorker && options.format === "iife") {
        options.format = "es";
        isWorkerIifeRequested = true;
      }
    },

    config(config, env) {
      if (env.command === "build") {
        if (config.worker) {
          isWorker = true;
        }

        buildTarget = config.build?.target ?? DEFAULT_VITE_TARGET;
        config.build = config.build || {};
        config.build.target = "esnext";

        minify = !!config.build.minify;

        assetsDir = config.build.assetsDir || "assets";
      }

      if (env.command === "serve") {
        if (config.optimizeDeps?.esbuildOptions) {
          config.optimizeDeps.esbuildOptions.target = "esnext";
        }
      }
    },

    async renderChunk(code, chunk, outputOptions, meta) {
      if (outputOptions.format !== "es") return null;

      // Phase 1: Parse and detect TLA/dynamic imports
      const ast = parse(code, {
        ecmaVersion: 2022,
        sourceType: "module",
        locations: true
      }) as any; // acorn returns estree-compatible AST

      const detection = detect(ast);

      // Report to barrier and wait for all chunks
      const totalChunks = Object.keys(meta.chunks).length;
      barrier.report(chunk.fileName, {
        hasTLA: detection.hasTLA,
        hasDynamicImport: detection.hasDynamicImport,
        ast,
        code
      }, totalChunks);

      const analysisMap = await barrier.wait();

      // Phase 2: Build dependency graph
      const graph = buildBundleGraph(analysisMap, meta.chunks);

      // Phase 3: Transform if needed
      if (!graph[chunk.fileName]?.transformNeeded) {
        if (buildTarget !== "esnext") {
          const downleveled = await buildRawTarget(code);
          return { code: downleveled, map: null };
        }
        return null;
      }

      const result = transformChunk(code, ast, chunk.fileName, graph, resolvedOptions);

      // Phase 4: Target downleveling with sourcemap chaining
      if (buildTarget !== "esnext") {
        const downleveled = await esbuild.transform(result.code, {
          minify,
          target: buildTarget as string | string[],
          format: "esm",
          sourcemap: true,
          sourcesContent: false
        });

        const chainedMap = remapping(
          [downleveled.map as any, result.map as any],
          () => null
        );

        return {
          code: downleveled.code,
          map: chainedMap as any
        };
      }

      return {
        code: result.code,
        map: result.map
      };
    },

    async generateBundle(_bundleOptions, bundle) {
      if (!(isWorker && isWorkerIifeRequested)) return;

      await convertWorkerToIife(bundle, {
        assetsDir,
        minify,
        buildTarget: buildTarget as string | string[]
      });
    }
  };
}
