import { build } from "esbuild";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { readFileSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(HERE, "package.json"), "utf8"));

const common = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22.13",
  external: ["@signalapp/libsignal-client"],
  legalComments: "none",
  sourcemap: false,
  define: {
    __CLI_VERSION__: JSON.stringify(pkg.version),
  },
  banner: {
    js: '#!/usr/bin/env node\nimport { createRequire } from "node:module";\nconst require = createRequire(import.meta.url);',
  },
};

await build({ ...common, entryPoints: [resolve(HERE, "src/commands/cli.ts")], outfile: resolve(HERE, "dist/cli.js") });

// The operator console (flow 002 T9). It is a separate binary rather than a ninth CLI command:
// the eight-command surface is deliberately frozen, and the console drives that surface as a
// child process rather than joining it. It resolves `dist/cli.js` beside itself by default.
await build({ ...common, entryPoints: [resolve(HERE, "src/tui/main.ts")], outfile: resolve(HERE, "dist/tui.js") });
