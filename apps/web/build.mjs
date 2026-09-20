import { build } from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

await mkdir(resolve(__dirname, "dist/client"), { recursive: true });

// 1. Build Server
console.log("Building server...");
await build({
  entryPoints: [resolve(__dirname, "src/server/server.ts")],
  outfile: resolve(__dirname, "dist/server.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22.13",
  legalComments: "none",
  sourcemap: false,
  banner: {
    js: '#!/usr/bin/env node\nimport { createRequire } from "node:module";\nconst require = createRequire(import.meta.url);',
  },
});

// 2. Build Client (React SPA)
console.log("Building client...");
await build({
  entryPoints: [resolve(__dirname, "src/client/index.tsx")],
  outfile: resolve(__dirname, "dist/client/bundle.js"),
  bundle: true,
  platform: "browser",
  format: "esm",
  target: "es2022",
  minify: true,
  sourcemap: false,
  loader: { ".tsx": "tsx", ".ts": "ts" },
  define: {
    "process.env.NODE_ENV": '"production"',
  },
});

// 3. Copy Static Assets
console.log("Copying static assets...");
await copyFile(resolve(__dirname, "src/client/index.html"), resolve(__dirname, "dist/client/index.html"));
await copyFile(resolve(__dirname, "src/client/styles.css"), resolve(__dirname, "dist/client/styles.css"));
try {
  const { cp } = await import("node:fs/promises");
  await cp(resolve(__dirname, "src/client/assets"), resolve(__dirname, "dist/client/assets"), { recursive: true });
} catch (e) {
  console.warn("Failed to copy assets directory:", e);
}

console.log("Build complete!");
