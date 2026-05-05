import { spawn } from 'node:child_process'
import { version } from '../../package.json'
import { Hono } from 'hono'
import { stream } from 'hono/streaming'
import { cors } from 'hono/cors'
import { Discovery } from './discovery.ts'
import { MqttPool } from './mqtt-pool.ts'
import { SshPool } from './ssh.ts'
import { ChatStore } from './chats.ts'
import { LlmClient } from './llm.ts'
import { dispatch, toolSchemas } from './tools.ts'
import { embeddedAsset, embeddedIndex } from './embed.ts'
import { SettingsStore, listModels } from './settings.ts'
import { openDb } from './db.ts'

const PORT = Number(process.env['WB_HELPER_PORT'] ?? 17321)

const settingsStore = new SettingsStore()
const settings = await settingsStore.load()
const db = await openDb()

const discovery = new Discovery(db)
let mqtt = new MqttPool({ user: settings.mqttUser, password: settings.mqttPassword })
const ssh = new SshPool({
  user: settings.sshUser,
  password: settings.sshPassword,
  keyPath: settings.sshKeyPath,
})
const chats = new ChatStore(db)
let llm: LlmClient | null = settings.apiKey
  ? new LlmClient({
      apiKey: settings.apiKey,
      baseURL: settings.baseURL || undefined,
      model: settings.model || 'gpt-4.1-mini',
    })
  : null

settingsStore.onChange((s) => {
  llm = s.apiKey
    ? new LlmClient({
        apiKey: s.apiKey,
        baseURL: s.baseURL || undefined,
        model: s.model || 'gpt-4.1-mini',
      })
    : null
  void mqtt.close()
  mqtt = new MqttPool({ user: s.mqttUser, password: s.mqttPassword })
  ssh.setAuth({ user: s.sshUser, password: s.sshPassword, keyPath: s.sshKeyPath })
})

discovery.start(settings.discoveryInterval)

const sseClients = new Set<(payload: string) => void>()
discovery.onChange((list) => broadcast('controllers', list))

const app = new Hono()
app.use('/api/*', cors())

app.get('/api/health', (c) =>
  c.json({
    ok: true,
    version,
    llmConfigured: !!llm,
    model: llm?.model ?? null,
    port: PORT,
    discoveryInterval: settingsStore.get().discoveryInterval,
  }),
)

app.get('/api/settings', (c) => c.json(settingsStore.toPublic()))

app.put('/api/settings', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  const patch: Record<string, unknown> = {}
  const stringFields = ['apiKey', 'baseURL', 'model', 'mqttUser', 'mqttPassword', 'sshUser', 'sshPassword', 'sshKeyPath']
  for (const f of stringFields) {
    if (typeof body[f] === 'string') patch[f] = body[f]
  }
  if (typeof body['discoveryInterval'] === 'number') patch['discoveryInterval'] = body['discoveryInterval']
  if (typeof body['openBrowser'] === 'boolean') patch['openBrowser'] = body['openBrowser']
  await settingsStore.update(patch)
  return c.json(settingsStore.toPublic())
})

app.delete('/api/settings/api-key', async (c) => {
  await settingsStore.clearKey()
  return c.json(settingsStore.toPublic())
})

app.get('/api/models', async (c) => {
  const s = settingsStore.get()
  if (!s.apiKey) return c.json({ error: 'apiKey не задан' }, 400)
  try {
    const models = await listModels(s.apiKey, s.baseURL || undefined)
    return c.json({ models })
  } catch (e: any) {
    return c.json({ error: e?.message ?? String(e) }, 502)
  }
})

app.get('/api/controllers', (c) => c.json({ controllers: discovery.list() }))

app.post('/api/controllers', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const host = String(body.host ?? '').trim()
  if (!host) return c.json({ error: 'host required' }, 400)
  const ctrl = discovery.addManual(host)
  return c.json(ctrl)
})

app.post('/api/controllers/refresh', async (c) => {
  await discovery.refresh()
  return c.json({ controllers: discovery.list() })
})

app.delete('/api/controllers/:sn', (c) => {
  discovery.remove(c.req.param('sn'))
  return c.json({ ok: true })
})

app.get('/api/stats', (c) => c.json(chats.globalStats()))

app.get('/api/chats', (c) => c.json({ chats: chats.list() }))

app.post('/api/chats', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const chat = chats.create(body.title, Array.isArray(body.contextSns) ? body.contextSns : [])
  return c.json(chat)
})

app.get('/api/chats/:id', (c) => {
  const chat = chats.get(c.req.param('id'))
  return chat ? c.json(chat) : c.json({ error: 'not found' }, 404)
})

app.patch('/api/chats/:id', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const id = c.req.param('id')
  let chat = chats.get(id)
  if (!chat) return c.json({ error: 'not found' }, 404)
  if (typeof body.title === 'string') chat = chats.rename(id, body.title) ?? chat
  if (Array.isArray(body.contextSns)) chat = chats.setContext(id, body.contextSns) ?? chat
  return c.json(chat)
})

app.delete('/api/chats/:id', (c) => {
  chats.remove(c.req.param('id'))
  return c.json({ ok: true })
})

app.post('/api/chats/:id/message', async (c) => {
  const activeLlm = llm
  if (!activeLlm) {
    return c.json({ error: 'API-ключ не задан. Откройте «Настройки» и введите OPENAI_API_KEY.' }, 503)
  }
  const id = c.req.param('id')
  const chat = chats.get(id)
  if (!chat) return c.json({ error: 'not found' }, 404)
  const body = await c.req.json().catch(() => ({}))
  const userText = String(body.text ?? '').trim()
  if (!userText) return c.json({ error: 'text required' }, 400)

  chats.appendTurn(id, { role: 'user', content: userText })

  return stream(c, async (s) => {
    const send = (event: string, data: unknown) => s.write(formatSse(event, data))
    await send('user', { text: userText })

    const ctx = { discovery, mqtt, ssh, contextSns: chat.contextSns }
    let assistantText = ''
    const pendingToolCalls: { id: string; name: string; arguments: string }[] = []
    let pendingUsage: { promptTokens: number; completionTokens: number } | null = null

    try {
      for await (const ev of activeLlm.runAgent(
        chat.turns,
        toolSchemas(),
        (name, args) => dispatch(name, args, ctx),
        { maxTurns: 8 },
      )) {
        await send(ev.type, ev)
        if (ev.type === 'text-delta') assistantText += ev.text
        if (ev.type === 'usage') {
          pendingUsage = { promptTokens: ev.promptTokens, completionTokens: ev.completionTokens }
        }
        if (ev.type === 'tool-call') {
          pendingToolCalls.push({ id: ev.id, name: ev.name, arguments: ev.arguments })
        }
        if (ev.type === 'tool-result') {
          if (assistantText || pendingToolCalls.length) {
            chats.appendTurn(id, {
              role: 'assistant',
              content: assistantText,
              toolCalls: [...pendingToolCalls],
            })
            assistantText = ''
            pendingToolCalls.length = 0
          }
          chats.appendTurn(id, { role: 'tool', toolCallId: ev.id, content: ev.result })
        }
      }
    } catch (e: any) {
      await send('error', { message: e?.message ?? String(e) })
    }

    if (assistantText || pendingToolCalls.length) {
      chats.appendTurn(
        id,
        {
          role: 'assistant',
          content: assistantText,
          toolCalls: pendingToolCalls.length ? [...pendingToolCalls] : undefined,
        },
        pendingUsage ?? undefined,
      )
    }
    await send('end', { chatId: id })
  }, async (err, s) => {
    await s.write(formatSse('error', { message: String(err) }))
  })
})

app.get('/api/events', (c) =>
  stream(c, async (s) => {
    const send = (event: string, data: unknown) => s.write(formatSse(event, data))
    await send('hello', { ts: Date.now() })
    await send('controllers', discovery.list())
    let active = true
    s.onAbort(() => { active = false })
    const push = (payload: string) => { if (active) void s.write(payload) }
    sseClients.add(push)
    while (active) {
      await new Promise((r) => setTimeout(r, 15000))
      if (active) await send('ping', { ts: Date.now() })
    }
    sseClients.delete(push)
  }),
)

// Static UI from embedded assets.
app.get('/', () => embeddedIndex())
app.get('/assets/*', (c) => {
  const rel = c.req.path.replace(/^\//, '')
  const res = embeddedAsset(rel)
  return res ?? c.notFound()
})
app.get('/favicon.ico', (c) => embeddedAsset('favicon.ico') ?? c.notFound())

const server = Bun.serve({
  port: PORT,
  hostname: '127.0.0.1',
  fetch: app.fetch,
})

console.log(`WB Helper запущен:          http://${server.hostname}:${server.port}/`)
console.log(`Настройки:                  ${settingsStore.storagePath()}`)
console.log(`LLM:                        ${llm ? `${llm.model} (${settings.baseURL || 'OpenAI'})` : 'не настроен — введите ключ через UI'}`)
console.log(`mDNS-сканирование:          каждые ${settings.discoveryInterval} мс`)

if (settings.openBrowser) openBrowser(`http://127.0.0.1:${server.port}/`)

const shutdown = () => {
  console.log('\nЗавершение…')
  discovery.stop()
  void mqtt.close()
  void ssh.closeAll()
  db.close()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

function formatSse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

function broadcast(event: string, data: unknown) {
  const payload = formatSse(event, data)
  for (const fn of sseClients) fn(payload)
}

function openBrowser(url: string) {
  const cmd: [string, string[]] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '""', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]]
  try {
    spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' }).unref()
  } catch {}
}
