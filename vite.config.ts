import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  build: {
    manifest: true,
    // math 入口单独打包，阅读页按需加载 KaTeX。
    rollupOptions: { input: { main: 'index.html', math: 'src/math.ts' } },
  },
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:8000',
      '/media': 'http://127.0.0.1:8000',
      '/posts': 'http://127.0.0.1:8000',
      '/content-assets': 'http://127.0.0.1:8000',
      '/sitemap.xml': 'http://127.0.0.1:8000',
      '/feed.xml': 'http://127.0.0.1:8000',
      '/notes': 'http://127.0.0.1:8000',
      '/robots.txt': 'http://127.0.0.1:8000',
    },
  },
})
