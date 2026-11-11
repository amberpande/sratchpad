// Bundles the API into dist/server.mjs for `node dist/server.mjs` (no tsx in production).
// Workspace packages (@yourorg/*, shipped as TypeScript source) are bundled in; every third-party
// runtime dependency stays external and is installed in the image (DuckDB is a native module).
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const external = Object.keys(pkg.dependencies ?? {}).filter((d) => !d.startsWith('@yourorg/'));

await build({
  entryPoints: [new URL('../src/server.ts', import.meta.url).pathname],
  outfile: new URL('../dist/server.mjs', import.meta.url).pathname,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  external: [...external, ...external.map((d) => `${d}/*`)],
  // Bundled CommonJS code (e.g. zod's) may call require(); give ESM output one.
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: 'info',
});
