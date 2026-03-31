// Import the `esbuild` package installed by `vite`

import { createRequire } from "module";

const viteEntry = require.resolve("vite");
const requireFromVite = createRequire(viteEntry);

export default requireFromVite("esbuild") as typeof import("esbuild");
