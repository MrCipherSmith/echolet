import { build } from "esbuild";

await build({
  entryPoints: ["src/commands/cli.ts"],
  outfile: "dist/cli.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22.13",
  external: ["@signalapp/libsignal-client"],
  legalComments: "none",
  sourcemap: false,
  banner: {
    js: '#!/usr/bin/env node\nimport { createRequire } from "node:module";\nconst require = createRequire(import.meta.url);',
  },
});
