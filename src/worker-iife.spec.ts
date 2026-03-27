import { convertWorkerToIife } from "./worker-iife";
import type { OutputBundle, OutputChunk } from "rollup";

function makeChunk(code: string, isEntry = false): OutputChunk {
  return {
    type: "chunk",
    code,
    fileName: isEntry ? "worker.js" : "chunk.js",
    isEntry,
    isDynamicEntry: false,
    isImplicitEntry: false,
    exports: [],
    facadeModuleId: null,
    map: null,
    modules: {},
    moduleIds: [],
    imports: [],
    importedBindings: {},
    dynamicImports: [],
    referencedFiles: [],
    implicitlyLoadedBefore: [],
    preliminaryFileName: isEntry ? "worker.js" : "chunk.js",
    sourcemapFileName: null,
    name: isEntry ? "worker" : "chunk"
  } as unknown as OutputChunk;
}

describe("convertWorkerToIife", () => {
  it("should convert ES bundle to IIFE", async () => {
    const bundle: OutputBundle = {
      "worker.js": makeChunk(
        `var x = 42;\nconsole.log(x);\n`,
        true
      )
    };

    await convertWorkerToIife(bundle, {
      assetsDir: "assets",
      minify: false,
      buildTarget: "es2020"
    });

    // Entry should be replaced
    const keys = Object.keys(bundle);
    expect(keys).toHaveLength(1);

    const entry = bundle[keys[0]] as OutputChunk;
    expect(entry.code).toContain("(function(");
    // Polyfill should be present
    expect(entry.code).toContain("currentScript");
  }, 30000);

  it("should remove extra chunks and keep only entry", async () => {
    const bundle: OutputBundle = {
      "worker.js": makeChunk(`import { helper } from "./helper.js";\nhelper();\n`, true),
      "helper.js": makeChunk(`export function helper() { return 42; }`)
    };

    await convertWorkerToIife(bundle, {
      assetsDir: "assets",
      minify: false,
      buildTarget: "es2020"
    });

    // Only one file should remain
    expect(Object.keys(bundle)).toHaveLength(1);
  }, 30000);

  it("should throw if no entry found", async () => {
    const bundle: OutputBundle = {
      "chunk.js": makeChunk(`export function foo() {}`, false)
    };

    await expect(
      convertWorkerToIife(bundle, {
        assetsDir: "assets",
        minify: false,
        buildTarget: "es2020"
      })
    ).rejects.toThrow("Entry not found");
  }, 30000);
});
