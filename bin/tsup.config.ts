import { defineConfig } from "tsup";

// Bundle the @owl/* workspace packages into the CLI so the published bin is
// self-contained and runnable via node/npx without TS source resolution.
export default defineConfig({
  entry: ["src/owl.ts"],
  format: ["esm"],
  clean: true,
  dts: false,
  // Inline only the @owl/* workspace source; keep third-party libs external so
  // they load from node_modules at runtime (avoids bundling CJS dynamic-require
  // libs like gray-matter/chokidar into the ESM bundle).
  noExternal: [/^@owl\//],
  external: ["gray-matter", "zod", "chokidar", "hono", "@hono/node-server"],
  banner: { js: "#!/usr/bin/env node" },
});
