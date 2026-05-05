// Реальный манифест с путями ассетов генерится scripts/build.ts перед компиляцией.
// В dev-режиме FILES пустой → отдаём placeholder.

import { FILES } from './embed-manifest.ts'

export function embeddedIndex(): Response {
  const path = FILES['index.html']
  if (!path) {
    return new Response(PLACEHOLDER_HTML, {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    })
  }
  return new Response(Bun.file(path), {
    headers: { 'content-type': 'text/html; charset=utf-8' },
  })
}

export function embeddedAsset(rel: string): Response | null {
  const path = FILES[rel]
  if (!path) return null
  return new Response(Bun.file(path), {
    headers: { 'content-type': mimeFor(rel) },
  })
}

function mimeFor(p: string): string {
  if (p.endsWith('.js')) return 'application/javascript; charset=utf-8'
  if (p.endsWith('.css')) return 'text/css; charset=utf-8'
  if (p.endsWith('.svg')) return 'image/svg+xml'
  if (p.endsWith('.png')) return 'image/png'
  if (p.endsWith('.json')) return 'application/json'
  if (p.endsWith('.woff2')) return 'font/woff2'
  if (p.endsWith('.html')) return 'text/html; charset=utf-8'
  if (p.endsWith('.ico')) return 'image/x-icon'
  return 'application/octet-stream'
}

const PLACEHOLDER_HTML = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><title>WB Helper (dev)</title>
<style>body{font-family:sans-serif;max-width:640px;margin:60px auto;color:#222}code{background:#f3f3f3;padding:2px 4px}</style>
</head><body>
<h1>WB Helper</h1>
<p>UI ещё не собран. Запустите:</p>
<pre><code>bun run build:web</code></pre>
<p>Или для разработки откройте <a href="http://127.0.0.1:5173/">vite на :5173</a>
после <code>bun run dev:web</code> (он проксирует /api сюда).</p>
</body></html>`
