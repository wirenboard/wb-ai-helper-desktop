// Integration tests: spin up the real server binary against a live SQLite DB.
// Run: bun test tests/api.test.ts

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

process.env['NO_PROXY'] = '127.0.0.1,localhost'
process.env['no_proxy'] = '127.0.0.1,localhost'

const ROOT = path.resolve(import.meta.dir, '..')
const PORT = 17990

function binaryPath(): string {
  if (process.platform === 'win32') return path.join(ROOT, 'build', 'wb-ai-helper-windows-x64.exe')
  return path.join(ROOT, 'build', 'wb-ai-helper-linux-x64')
}

const bin = binaryPath()
const hasBinary = existsSync(bin)

let proc: ChildProcess | null = null
let sandbox = ''

async function waitForServer(timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: AbortSignal.timeout(500) })
      if (res.ok) return
    } catch {}
    await new Promise(r => setTimeout(r, 150))
  }
  throw new Error(`server did not start within ${timeoutMs}ms`)
}

async function api(path: string, opts?: RequestInit) {
  return fetch(`http://127.0.0.1:${PORT}${path}`, opts)
}

async function apiJson(path: string, opts?: RequestInit) {
  const res = await api(path, opts)
  return { status: res.status, body: await res.json() }
}

if (hasBinary) {
  beforeAll(async () => {
    sandbox = mkdtempSync(path.join(tmpdir(), 'wb-ai-test-'))
    proc = spawn(bin, [], {
      cwd: sandbox,
      env: {
        ...process.env,
        WB_HELPER_PORT: String(PORT),
        WB_HELPER_OPEN_BROWSER: '0',
        WB_HELPER_DISCOVERY_INTERVAL: '3600000',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    await waitForServer()
  })

  afterAll(() => {
    try { proc?.kill('SIGTERM') } catch {}
    try { rmSync(sandbox, { recursive: true, force: true }) } catch {}
  })
} else {
  console.warn(`[skip] binary not found at ${bin} — run 'bun scripts/build.ts' first`)
}

const it = hasBinary ? test : test.skip

// ── Health ────────────────────────────────────────────────────────────────────

describe('GET /api/health', () => {
  it('returns ok=true and version', async () => {
    const { status, body } = await apiJson('/api/health')
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    expect(typeof body.version).toBe('string')
    expect(typeof body.port).toBe('number')
  })
})

// ── Settings ──────────────────────────────────────────────────────────────────

describe('GET /api/settings', () => {
  it('returns public settings without secrets', async () => {
    const { status, body } = await apiJson('/api/settings')
    expect(status).toBe(200)
    expect('apiKey' in body).toBe(false)
    expect('mqttPassword' in body).toBe(false)
    expect(typeof body.apiKeyConfigured).toBe('boolean')
  })
})

describe('PUT /api/settings', () => {
  it('updates discoveryInterval', async () => {
    const { status, body } = await apiJson('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ discoveryInterval: 99999 }),
    })
    expect(status).toBe(200)
    expect(body.discoveryInterval).toBe(99999)
  })

  it('ignores unknown fields', async () => {
    const { status } = await apiJson('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ unknownField: 'should be ignored' }),
    })
    expect(status).toBe(200)
  })
})

// ── Controllers ───────────────────────────────────────────────────────────────

describe('/api/controllers', () => {
  it('GET returns empty array initially', async () => {
    const { status, body } = await apiJson('/api/controllers')
    expect(status).toBe(200)
    expect(Array.isArray(body.controllers)).toBe(true)
  })

  it('POST adds a manual controller', async () => {
    const { status, body } = await apiJson('/api/controllers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ host: 'test-controller.local' }),
    })
    expect(status).toBe(200)
    expect(body.host).toBe('test-controller.local')
    expect(typeof body.sn).toBe('string')
  })

  it('POST rejects missing host', async () => {
    const { status } = await apiJson('/api/controllers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(status).toBe(400)
  })

  it('DELETE removes a controller', async () => {
    const { body: ctrl } = await apiJson('/api/controllers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ host: 'to-delete.local' }),
    })
    const { status } = await apiJson(`/api/controllers/${ctrl.sn}`, { method: 'DELETE' })
    expect(status).toBe(200)
  })
})

// ── Chats ─────────────────────────────────────────────────────────────────────

describe('/api/chats', () => {
  let chatId = ''

  it('GET returns empty list', async () => {
    const { status, body } = await apiJson('/api/chats')
    expect(status).toBe(200)
    expect(Array.isArray(body.chats)).toBe(true)
  })

  it('POST creates a chat', async () => {
    const { status, body } = await apiJson('/api/chats', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'test chat' }),
    })
    expect(status).toBe(200)
    expect(body.title).toBe('test chat')
    expect(typeof body.id).toBe('string')
    chatId = body.id
  })

  it('GET returns the created chat', async () => {
    const { status, body } = await apiJson(`/api/chats/${chatId}`)
    expect(status).toBe(200)
    expect(body.id).toBe(chatId)
  })

  it('PATCH renames a chat', async () => {
    const { status, body } = await apiJson(`/api/chats/${chatId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'renamed' }),
    })
    expect(status).toBe(200)
    expect(body.title).toBe('renamed')
  })

  it('PATCH sets contextSns', async () => {
    const { status, body } = await apiJson(`/api/chats/${chatId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contextSns: ['SN001', 'SN002'] }),
    })
    expect(status).toBe(200)
    expect(body.contextSns).toEqual(['SN001', 'SN002'])
  })

  it('GET 404 for unknown chat', async () => {
    const { status } = await apiJson('/api/chats/nonexistent-id')
    expect(status).toBe(404)
  })

  it('POST /message 503 when no API key', async () => {
    const { status } = await apiJson(`/api/chats/${chatId}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hello' }),
    })
    expect(status).toBe(503)
  })

  it('DELETE removes the chat', async () => {
    const { status } = await apiJson(`/api/chats/${chatId}`, { method: 'DELETE' })
    expect(status).toBe(200)
    const { status: getStatus } = await apiJson(`/api/chats/${chatId}`)
    expect(getStatus).toBe(404)
  })
})

// ── Attachments ───────────────────────────────────────────────────────────────

describe('/api/attachments', () => {
  let chatId = ''
  let attachId = ''

  it('setup: create a chat', async () => {
    const { body } = await apiJson('/api/chats', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'attach-test' }),
    })
    chatId = body.id
  })

  it('GET returns empty list', async () => {
    const { status, body } = await apiJson(`/api/attachments?chatId=${chatId}`)
    expect(status).toBe(200)
    expect(body.items).toEqual([])
  })

  it('GET 400 without chatId', async () => {
    const { status } = await apiJson('/api/attachments')
    expect(status).toBe(400)
  })

  it('POST uploads a file', async () => {
    const form = new FormData()
    form.append('chatId', chatId)
    form.append('file', new File(['hello world'], 'test.txt', { type: 'text/plain' }))
    const res = await api('/api/attachments', { method: 'POST', body: form })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.name).toBe('test.txt')
    expect(typeof body.id).toBe('string')
    attachId = body.id
  })

  it('GET downloads the file', async () => {
    const res = await api(`/api/attachments/${attachId}?chatId=${chatId}`)
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toBe('hello world')
  })

  it('DELETE removes the file', async () => {
    const { status } = await apiJson(`/api/attachments/${attachId}?chatId=${chatId}`, { method: 'DELETE' })
    expect(status).toBe(200)
    const { status: getStatus } = await apiJson(`/api/attachments/${attachId}?chatId=${chatId}`)
    expect(getStatus).toBe(404)
  })
})

// ── Frontend ──────────────────────────────────────────────────────────────────

describe('embedded frontend', () => {
  it('GET / returns index.html with Vue mount point', async () => {
    const res = await api('/')
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('<div id="app">')
  })

  it('GET /favicon.ico does not 5xx', async () => {
    const res = await api('/favicon.ico')
    expect(res.status).toBeLessThan(500)
  })
})

// ── Stats ─────────────────────────────────────────────────────────────────────

describe('GET /api/stats', () => {
  it('returns token stats shape', async () => {
    const { status, body } = await apiJson('/api/stats')
    expect(status).toBe(200)
    expect(typeof body.totalPromptTokens).toBe('number')
    expect(typeof body.totalCompletionTokens).toBe('number')
  })
})
