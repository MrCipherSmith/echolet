import { build } from "esbuild";

const common = {
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
};

await build({ ...common, entryPoints: ["src/commands/cli.ts"], outfile: "dist/cli.js" });

// The operator console (flow 002 T9). It is a separate binary rather than a ninth CLI command:
// the eight-command surface is deliberately frozen, and the console drives that surface as a
// child process rather than joining it. It resolves `dist/cli.js` beside itself by default.
await build({ ...common, entryPoints: ["src/tui/main.ts"], outfile: "dist/tui.js" });
