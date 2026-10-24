import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig(({ mode }) => {
  // 本地可用 COPYLEE_BACKEND 指向其他端口的后端（例如与另一套开发环境并行时）。
  const backend = loadEnv(mode, '.', '').COPYLEE_BACKEND || 'http://127.0.0.1:8000'
  return {
    plugins: [vue()],
    build: {
      manifest: true,
      // math 入口单独打包，阅读页按需加载 KaTeX。
      rollupOptions: { input: { main: 'index.html', math: 'src/math.ts' } },
    },
    server: {
      proxy: {
        '/api': backend,
        '/media': backend,
        '/posts': backend,
        '/content-assets': backend,
        '/sitemap.xml': backend,
        '/feed.xml': backend,
        '/notes': backend,
        '/privacy': backend,
        '/robots.txt': backend,
      },
    },
  }
})
