import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { devMock } from './dev/mock-plugin.mjs';

// Builds the Iris console into web/dist/, served by gateway.mjs in production.
// The dev server runs the API mock so the UI previews without the backend.
export default defineConfig({
  root: '.',
  plugins: [vue(), devMock()],
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
});
