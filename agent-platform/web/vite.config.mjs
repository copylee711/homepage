import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const katexDist = dirname(createRequire(import.meta.url).resolve('katex'));
const widgetMath = () => ['katex.min.js', 'contrib/auto-render.min.js']
  .map(path => readFileSync(join(katexDist, path), 'utf8')).join('\n');

// Builds the Iris console into web/dist/, served by gateway.mjs in production.
// The dev server runs the API mock so the UI previews without the backend.
// Load that plugin only for `serve`. A string-literal import() is still bundled
// by esbuild and resolves the mock's parent modules during `vite build`, so the
// specifier has to be computed from this file's URL at runtime.
async function loadDevMock() {
  const specifier = new URL('./dev/mock-plugin.mjs', import.meta.url).href + '?t=' + Date.now();
  const { devMock } = await import(specifier);
  return devMock(widgetMath());
}

export default defineConfig(async ({ command }) => ({
  root: '.',
  plugins: [vue(), {
    name: 'iris-widget-math',
    apply: 'build',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'widget-math.js', source: widgetMath() });
    },
  }, ...(command === 'serve' ? [await loadDevMock()] : [])],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    assetsDir: 'assets',
    sourcemap: false,
  },
  server: {
    host: '127.0.0.1',
    port: 4178,
    strictPort: true,
  },
}));
