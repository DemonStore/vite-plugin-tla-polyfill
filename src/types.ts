import type { Program } from "estree";

export interface Options {
  promiseExportName?: string;
  promiseImportName?: (i: number) => string;
}

export const DEFAULT_OPTIONS: Required<Options> = {
  promiseExportName: "__tla",
  promiseImportName: i => `__tla_${i}`
};

export interface ChunkAnalysis {
  hasTLA: boolean;
  hasDynamicImport: boolean;
  ast: Program;
  code: string;
}

export interface ChunkMeta {
  imports: string[];
  exports: string[];
}

export interface ChunkTransformInfo {
  transformNeeded: boolean;
  tlaImports: string[];
  importedBy: string[];
}

export type BundleGraph = Record<string, ChunkTransformInfo>;
