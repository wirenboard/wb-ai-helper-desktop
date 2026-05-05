// Smoke-тест: запускает свежесобранный бинарник, дёргает /api/health и /api/controllers,
// проверяет что фронтенд (index.html) встроен. Завершается с кодом 0 если всё ОК.
//
// Использование:  bun scripts/smoke.ts [path-to-binary]

import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, rmSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dir, '..')
const fallback = path.join(ROOT, 'build', defaultBinary())
const bin = Bun.argv[2] ?? fallback
const PORT = 17999

if (!existsSync(bin)) {
  console.error(`Бинарник не найден: ${bin}\nСоберите его: bun scripts/build.ts`)
  process.exit(1)
}

// Run from a clean tempdir so the binary's wb-ai-helper-settings.json (created by /api/settings)
// doesn't pollute build/.
const sandbox = mkdtempSync(path.join(tmpdir(), 'wb-ai-helper-smoke-'))
const sandboxBin = path.join(sandbox, path.basename(bin))
copyFileSync(bin, sandboxBin)
chmodSync(sandboxBin, 0o755)

console.log(`▸ Запуск ${sandboxBin} на порту ${PORT}`)
const proc = spawn(sandboxBin, [], {
  cwd: sandbox,
  env: {
    ...process.env,
    WB_HELPER_PORT: String(PORT),
    WB_HELPER_OPEN_BROWSER: '0',
    WB_HELPER_DISCOVERY_INTERVAL: '60000',
    OPENAI_API_KEY: process.env['OPENAI_API_KEY'] ?? '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})

let stdout = ''
proc.stdout.on('data', (d) => (stdout += d.toString()))
proc.stderr.on('data', (d) => (stdout += d.toString()))

const cleanup = () => {
  try { proc.kill('SIGTERM') } catch {}
  try { rmSync(sandbox, { recursive: true, force: true }) } catch {}
}
process.on('exit', cleanup)
process.on('SIGINT', () => { cleanup(); process.exit(130) })

const fail = (msg: string) => {
  cleanup()
  console.error(`\n✘ ${msg}`)
  if (stdout) console.error('--- stdout/stderr ---\n' + stdout)
  process.exit(1)
}

try {
  await waitForPort(PORT, 8000)
  console.log('▸ Порт открыт, проверяем эндпоинты')

  const health = await fetchJson(`http://127.0.0.1:${PORT}/api/health`)
  if (!health.ok) fail('health.ok = false')
  console.log(`  /api/health      ok=${health.ok} llm=${health.llmConfigured} model=${health.model}`)

  const list = await fetchJson(`http://127.0.0.1:${PORT}/api/controllers`)
  if (!Array.isArray(list.controllers)) fail('controllers не массив')
  console.log(`  /api/controllers controllers=${list.controllers.length}`)

  const indexRes = await fetch(`http://127.0.0.1:${PORT}/`)
  const html = await indexRes.text()
  if (!indexRes.ok) fail(`/ HTTP ${indexRes.status}`)
  if (!html.includes('<div id="app">')) fail('фронтенд не встроен (нет <div id="app">)')
  console.log(`  /                index.html встроен (${html.length} байт)`)

  cleanup()
  console.log('\n✔ Все проверки пройдены')
  process.exit(0)
} catch (e: any) {
  fail(e?.message ?? String(e))
}

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`)
  return await res.json()
}

async function waitForPort(port: number, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.timeout(500),
      })
      if (res.ok) return
    } catch {}
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`порт ${port} не открылся за ${timeoutMs} мс`)
}

function defaultBinary(): string {
  if (process.platform === 'win32') return 'wb-ai-helper-windows-x64.exe'
  return 'wb-ai-helper-linux-x64'
}
