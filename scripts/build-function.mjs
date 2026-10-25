import { build } from 'esbuild';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
await build({
  entryPoints: [resolve(root, 'functions/index.mjs')], outfile: resolve(root, '.deploy/index.mjs'),
  bundle: true, platform: 'node', target: 'node24', format: 'esm', external: ['pg-native'],
  define: { 'process.env.SPARELY_FUNCTION_RUNTIME': '"1"' },
  banner: { js: "import { createRequire as sparelyCreateRequire } from 'node:module'; const require = sparelyCreateRequire(import.meta.url);" }
});
console.log('Built backend/.deploy/index.mjs for Neon Node.js 24.');
