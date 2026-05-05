import { spawn } from 'node:child_process'
import path from 'node:path'
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
import { getTodos, formatTodos } from './todos.ts'
import { listSkills, getLoadedSkills, seedSystemSkills } from './skills.ts'
import { initAttachments, listSession as listAttachmentFiles, getAttachment, readAttachment, saveAttachment, deleteAttachment, cleanupExpired } from './attachments.ts'
import { getJobsForSession, updateJobState, removeJob } from './jobs.ts'

const PORT = Number(process.env['WB_HELPER_PORT'] ?? 17321)

const settingsStore = new SettingsStore()
const settings = await settingsStore.load()
const db = await openDb()

// Initialize attachments store next to the DB
const attachmentsRoot = path.join(path.dirname(settingsStore.storagePath()), 'attachments')
initAttachments(attachmentsRoot)

// Cleanup expired attachments every hour
setInterval(() => cleanupExpired(), 60 * 60 * 1000)

seedSystemSkills(db)

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
      llmProxy: settings.llmProxy || undefined,
      llmProxyUser: settings.llmProxyUser || undefined,
      llmProxyPassword: settings.llmProxyPassword || undefined,
      tlsInsecure: settings.tlsInsecure,
    })
  : null

settingsStore.onChange((s) => {
  llm = s.apiKey
    ? new LlmClient({
        apiKey: s.apiKey,
        baseURL: s.baseURL || undefined,
        model: s.model || 'gpt-4.1-mini',
        llmProxy: s.llmProxy || undefined,
        llmProxyUser: s.llmProxyUser || undefined,
        llmProxyPassword: s.llmProxyPassword || undefined,
        tlsInsecure: s.tlsInsecure,
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
  const stringFields = ['apiKey', 'baseURL', 'model', 'llmProxy', 'llmProxyUser', 'llmProxyPassword', 'mqttUser', 'mqttPassword', 'sshUser', 'sshPassword', 'sshKeyPath']
  for (const f of stringFields) {
    if (typeof body[f] === 'string') patch[f] = body[f]
  }
  if (typeof body['discoveryInterval'] === 'number') patch['discoveryInterval'] = body['discoveryInterval']
  if (typeof body['openBrowser'] === 'boolean') patch['openBrowser'] = body['openBrowser']
  if (typeof body['tlsInsecure'] === 'boolean') patch['tlsInsecure'] = body['tlsInsecure']
  for (const f of ['priceInput', 'priceOutput', 'priceCached']) {
    if (typeof body[f] === 'number' || body[f] === null) patch[f] = body[f]
  }
  await settingsStore.update(patch)
  if (typeof patch['discoveryInterval'] === 'number') {
    discovery.setInterval(patch['discoveryInterval'])
  }
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

app.get('/api/chats/:id/jobs', async (c) => {
  const id = c.req.param('id')
  const sessionJobs = getJobsForSession(id)
  // Refresh state for running jobs via SSH
  await Promise.all(
    sessionJobs
      .filter((j) => j.state === 'running')
      .map(async (j) => {
        const ctrl = discovery.get(j.sn)
        if (!ctrl) return
        try {
          const result = await ssh.jobStatus(ctrl, j.jobId)
          const state = result['state'] as 'running' | 'exited' | 'unknown'
          if (state === 'exited' || state === 'running') {
            updateJobState(j.jobId, state)
            j.state = state
          }
        } catch {}
      }),
  )
  return c.json({ jobs: sessionJobs })
})

app.post('/api/chats/:id/jobs/:jobId/cancel', async (c) => {
  const sessionId = c.req.param('id')
  const jobId = c.req.param('jobId')
  const sessionJobs = getJobsForSession(sessionId)
  const job = sessionJobs.find((j) => j.jobId === jobId)
  if (!job) return c.json({ error: 'job not found' }, 404)
  const ctrl = discovery.get(job.sn)
  if (!ctrl) return c.json({ error: `controller ${job.sn} not found` }, 404)
  try {
    await ssh.jobCancel(ctrl, jobId)
    removeJob(jobId)
    return c.json({ ok: true, jobId })
  } catch (e: any) {
    return c.json({ error: e?.message ?? String(e) }, 500)
  }
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

  const chatWithUser = chats.appendTurn(id, { role: 'user', content: userText })!

  return stream(c, async (s) => {
    const send = (event: string, data: unknown) => s.write(formatSse(event, data))
    await send('user', { text: userText })

    const agentState: { checkpointSummary?: string } = {}
    const ctx = { discovery, mqtt, ssh, contextSns: chat.contextSns, db, sessionId: id, agentState, braveApiKey: process.env['BRAVE_SEARCH_API_KEY'] }
    let assistantText = ''
    const pendingToolCalls: { id: string; name: string; arguments: string }[] = []
    let pendingUsage: { promptTokens: number; completionTokens: number; cachedTokens: number } | null = null

    try {
      for await (const ev of activeLlm.runAgent(
        chatWithUser.turns,
        toolSchemas(),
        (name, args) => dispatch(name, args, ctx),
        {
          maxTurns: 10,
          agentState,
          getExtraSystemMsgs: () => {
            const skills = listSkills(db)
            const catalog = skills.length
              ? skills.map((s) => `- ${s.name} — ${s.description}`).join('\n')
              : '(нет доступных скиллов)'
            const todos = getTodos(id)
            const loadedSkills = getLoadedSkills(id)
            const attachments = listAttachmentFiles(id)
            const sessionJobs = getJobsForSession(id)
            const runningJobs = sessionJobs.filter((j) => j.state === 'running')
            return [
              chat.contextSns.length
                ? `Текущий контекст — выбранные контроллеры: ${chat.contextSns.join(', ')}. Когда пользователь говорит «текущий», «этот», «он» про контроллер без явного SN — это эти SN. Если пользователь явно называет другой SN — ориентируйся на него.`
                : `Контекст не выбран — пользователь не выбрал ни одного контроллера в UI. Если задача требует SN — вызови list_controllers или спроси пользователя.`,
              `Каталог скиллов (подгружай через load_skill("<name>") ДО действий с контроллером):\n${catalog}`,
              todos.length
                ? `Текущий план работы (редактируй через todo_write):\n${formatTodos(todos)}`
                : 'План работы не задан. На задачах в 3+ шага сначала вызови todo_write.',
              attachments.length
                ? `Вложения текущего чата (файлы загруженные пользователем):\n${attachments.map(a => `- ${a.id}: ${a.name} (${a.size} байт, ${a.mime})`).join('\n')}\nДля чтения используй read_attachment(fileId). Для загрузки на контроллер — upload_to_controller(sn, fileId, path).`
                : 'Вложений нет. Если нужно загрузить файл на контроллер — попроси пользователя прикрепить его кнопкой 📎 в UI.',
              ...(runningJobs.length
                ? [`⚙ Активные фоновые задачи в этом чате:\n${runningJobs.map((j) => `  jobId=${j.jobId}  sn=${j.sn}  "${j.label}"`).join('\n')}\nИспользуй эти jobId для job_status/job_tail/job_cancel. Не вызывай job_status с jobId="unknown" — только с реальным 8-значным hex.`]
                : []),
              ...loadedSkills.map((s) => `Инструкции загруженного скилла "${s.name}" (активны в этой сессии):\n${s.content}`),
            ]
          },
        },
      )) {
        await send(ev.type, ev)
        if (ev.type === 'text-delta') assistantText += ev.text
        if (ev.type === 'usage') {
          pendingUsage = { promptTokens: ev.promptTokens, completionTokens: ev.completionTokens, cachedTokens: ev.cachedTokens }
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
          chats.appendTurn(id, { role: 'tool', toolCallId: ev.id, content: ev.ok ? ev.result : `\x01${ev.result}` })
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

// Attachments API
app.get('/api/attachments', (c) => {
  const chatId = c.req.query('chatId') ?? ''
  if (!chatId) return c.json({ error: 'chatId required' }, 400)
  return c.json({ items: listAttachmentFiles(chatId) })
})

app.post('/api/attachments', async (c) => {
  const form = await c.req.formData().catch(() => null)
  if (!form) return c.json({ error: 'form data required' }, 400)
  const chatId = form.get('chatId')
  const file = form.get('file')
  if (!chatId || typeof chatId !== 'string') return c.json({ error: 'chatId required' }, 400)
  if (!file || !(file instanceof File)) return c.json({ error: 'file required' }, 400)
  const buf = Buffer.from(await file.arrayBuffer())
  const r = saveAttachment(chatId, file.name, buf)
  if (!r.ok) return c.json({ error: r.error }, 400)
  return c.json(r.meta)
})

app.get('/api/attachments/:id', (c) => {
  const id = c.req.param('id')
  const chatId = c.req.query('chatId') ?? ''
  if (!chatId) return c.json({ error: 'chatId required' }, 400)
  const meta = getAttachment(chatId, id)
  if (!meta) return c.json({ error: 'not found' }, 404)
  const buf = readAttachment(chatId, id)
  if (!buf) return c.json({ error: 'data missing' }, 404)
  return new Response(buf, {
    headers: {
      'Content-Type': meta.mime,
      'Content-Disposition': `attachment; filename="${encodeURIComponent(meta.name)}"`,
      'Content-Length': String(meta.size),
    }
  })
})

app.delete('/api/attachments/:id', (c) => {
  const id = c.req.param('id')
  const chatId = c.req.query('chatId') ?? ''
  if (!chatId) return c.json({ error: 'chatId required' }, 400)
  deleteAttachment(chatId, id)
  return c.json({ ok: true })
})

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
  // Bun's default 10s idleTimeout rips long-lived SSE streams mid-flight
  // (tool-calling LLM turns easily exceed 10s between tokens). 0 disables it;
  // browser-side timeouts still apply.
  idleTimeout: 0,
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
