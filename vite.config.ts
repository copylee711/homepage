import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  build: { manifest: true },
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:8000',
      '/media': 'http://127.0.0.1:8000',
      '/posts': 'http://127.0.0.1:8000',
      '/content-assets': 'http://127.0.0.1:8000',
      '/sitemap.xml': 'http://127.0.0.1:8000',
      '/robots.txt': 'http://127.0.0.1:8000',
    },
  },
})
