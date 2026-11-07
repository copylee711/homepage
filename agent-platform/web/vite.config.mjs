import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// Builds the Iris console into web/dist/, served by gateway.mjs in production.
// The dev server runs the API mock so the UI previews without the backend.
// Load that plugin only for `serve`. A string-literal import() is still bundled
// by esbuild and resolves the mock's parent modules during `vite build`, so the
// specifier has to be computed from this file's URL at runtime.
async function loadDevMock() {
  const specifier = new URL('./dev/mock-plugin.mjs', import.meta.url).href;
  const { devMock } = await import(specifier);
  return devMock();
}

export default defineConfig(async ({ command }) => ({
  root: '.',
  plugins: [vue(), ...(command === 'serve' ? [await loadDevMock()] : [])],
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
