# vite-plugin-tla-polyfill

> Fork of [vite-plugin-top-level-await](https://github.com/Menci/vite-plugin-top-level-await) by [Menci](https://github.com/Menci).

Transform code to support top-level await in browsers for Vite. Supports all modern browsers of Vite's default target without requiring `build.target: "esnext"`.

**Requires Vite ≥ 5.**

## Why

Safari has a [critical bug](https://bugs.webkit.org/show_bug.cgi?id=242740) with top-level await that causes modules to execute before their TLA dependencies resolve. This plugin wraps TLA code in `Promise.all(...).then(async () => { ... })` chains so all browsers get the correct execution order.

## Installation

```bash
npm install -D vite-plugin-tla-polyfill
```

## Usage

```typescript
import topLevelAwait from "vite-plugin-tla-polyfill";

export default defineConfig({
  plugins: [
    topLevelAwait()
  ]
});
```

### Options

```typescript
topLevelAwait({
  // Name of the exported TLA promise in each transformed chunk.
  // Default: "__tla"
  promiseExportName: "__tla",

  // Function generating the import alias for TLA promises from dependencies.
  // Default: i => `__tla_${i}`
  promiseImportName: i => `__tla_${i}`
})
```

## Workers

Put the plugin in `config.worker.plugins` to support TLA in Web Workers.

- **ES format workers** — works transparently.
- **IIFE format workers** — the plugin builds the worker as ES first (IIFE doesn't support TLA natively), transforms it, then re-bundles to IIFE. Use IIFE when targeting Firefox.

```js
const myWorker = import.meta.env.DEV
  // Dev: workers need { type: "module" } since imports aren't bundled
  ? new Worker(new URL("./my-worker.js", import.meta.url), { type: "module" })
  // Build: single-file IIFE bundle, works in all browsers including Firefox
  : new Worker(new URL("./my-worker.js", import.meta.url), { type: "classic" });
```

## How it works

The plugin runs in Rollup's `renderChunk` hook (before chunk hashes are computed, fixing [issue #44](https://github.com/Menci/vite-plugin-top-level-await/issues/44)).

It transforms this:

```js
import { a } from "./a.js"; // has TLA
import { b } from "./b.js"; // has TLA
import { c } from "./c.js"; // no TLA

const x = 1;
await b.func();
const { y } = await somePromise;

export { x, y };
```

Into this:

```js
import { a, __tla as __tla_0 } from "./a.js";
import { b, __tla as __tla_1 } from "./b.js";
import { c } from "./c.js";

let x, y;

let __tla = Promise.all([
  (() => { try { return __tla_0; } catch {} })(),
  (() => { try { return __tla_1; } catch {} })()
]).then(async () => {
  x = 1;
  await b.func();
  ({ y } = await somePromise);
});

export { x, y, __tla };
```

Key properties:
- **Sourcemaps preserved** — magic-string makes surgical edits; original byte positions are unchanged.
- **Correct chunk hashes** — runs in `renderChunk`, so Rollup computes hashes from the transformed content.
- **Circular dependency safe** — each imported promise is wrapped in a try-catch to avoid errors when circular imports haven't resolved yet.
- **Dynamic imports** — `import("./mod")` is wrapped with `.then(async m => { await m.__tla; return m; })` when the target module has TLA.
- **Function/class hoisting** — exported functions and classes keep their hoisting semantics via a `__tla_export_*` binding pattern.

## Comparison with v1

| | v1 | v2 |
|---|---|---|
| Sourcemaps | Broken (SWC re-prints entire file) | Correct (magic-string surgical edits) |
| Chunk hashes | Wrong (generateBundle runs after hashing) | Correct (renderChunk runs before hashing) |
| Dependencies | ~80 MB (@swc/core + @swc/wasm) | ~1 MB (acorn + magic-string + remapping) |
| Min Vite version | 2.8 | 5.0 |
