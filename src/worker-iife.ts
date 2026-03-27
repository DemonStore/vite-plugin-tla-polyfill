import path from "path";
import type { OutputBundle, OutputChunk } from "rollup";
import type { TransformResult } from "esbuild";
import esbuild from "./esbuild";

interface WorkerIifeOptions {
  assetsDir: string;
  minify: boolean;
  buildTarget: string | string[];
}

export async function convertWorkerToIife(
  bundle: OutputBundle,
  options: WorkerIifeOptions
): Promise<void> {
  const { rollup } = await import("rollup");
  // @ts-ignore — @rollup/plugin-virtual is an optional dependency for worker IIFE support
  const virtual = (await import("@rollup/plugin-virtual")).default;

  const chunkNames = Object.keys(bundle).filter(key => bundle[key].type === "chunk");
  const entry = chunkNames.find(key => (bundle[key] as OutputChunk).isEntry);

  if (!entry) {
    throw new Error(
      "[vite-plugin-top-level-await] Entry not found in worker bundle! " +
      "Please submit an issue with a reproducible project."
    );
  }

  const newBuild = await rollup({
    input: entry,
    plugins: [
      virtual(
        Object.fromEntries(
          chunkNames.map(key => [key, (bundle[key] as OutputChunk).code])
        )
      )
    ]
  });

  const {
    output: [newEntry]
  } = await newBuild.generate({
    format: "iife",
    entryFileNames: path.posix.join(options.assetsDir, "[name].js")
  });

  // Polyfill document.currentScript.src since it's used for import.meta.url in workers
  const transformed: TransformResult = await esbuild.transform(
    `self.document = { currentScript: { src: self.location.href } };\n${newEntry.code}`,
    {
      minify: options.minify,
      target: options.buildTarget
    }
  );

  newEntry.code = transformed.code;

  // Replace ESM chunks with single IIFE entry
  for (const chunkName of chunkNames) {
    if (chunkName !== entry) delete bundle[chunkName];
  }
  bundle[entry] = newEntry;
}
