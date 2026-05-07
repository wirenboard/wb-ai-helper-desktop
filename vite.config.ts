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
      // ws: true прокидывает WebSocket-апгрейды (SSH-терминал на
      // /api/ssh/<sn>/shell). Без этого dev-сервер не пробрасывает WS
      // на backend и xterm видит «WebSocket error» / 404. В prod-сборке
      // (один процесс) этого нет — фронт и WS обслуживаются одним сервером.
      '^/api(/|$)': { target: 'http://127.0.0.1:17321', changeOrigin: false, ws: true },
    },
  },
})
