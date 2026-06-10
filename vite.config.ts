import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  root: fileURLToPath(new URL('./src/web', import.meta.url)),
  plugins: [vue()],
  build: {
    outDir: fileURLToPath(new URL('./src/web/dist', import.meta.url)),
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      // ws: true forwards WebSocket upgrades (SSH terminal at /api/ssh/<sn>/shell).
      // Without it the dev server won't proxy WS to the backend and xterm gets
      // «WebSocket error» / 404. Not needed in the prod build (single process
      // serves both frontend and WS).
      '^/api(/|$)': { target: 'http://127.0.0.1:17321', changeOrigin: false, ws: true },
    },
  },
})
