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
import { SettingsStore, listModels, PROVIDER_DEFAULTS, type Settings } from './settings.ts'
import { openDb } from './db.ts'
import { getTodos, formatTodos } from './todos.ts'
import { listSkills, getLoadedSkills, seedSystemSkills } from './skills.ts'
import { initAttachments, listSession as listAttachmentFiles, getAttachment, readAttachment, saveAttachment, deleteAttachment, clearSession as clearAttachmentSession, cleanupExpired } from './attachments.ts'
import { getJobsForSession, removeJob, startJobTracker } from './jobs.ts'

const PORT = Number(process.env['WB_HELPER_PORT'] ?? 17321)

const settingsStore = new SettingsStore()
const settings = await settingsStore.load()
const db = await openDb()

// Initialize attachments store next to the DB
const attachmentsRoot = path.join(path.dirname(settingsStore.storagePath()), 'attachments')
initAttachments(attachmentsRoot)

// Cleanup expired attachments every hour
setInterval(() => cleanupExpired(), 60 * 60 * 1000)

/** Pick a baseURL: explicit user value wins; otherwise fall back to the provider's default. */
/** Run `ss -tlnp` over SSH and pull a tidy list of TCP ports the controller exposes. */
async function listOpenPorts(ctrl: { sn: string; host: string }): Promise<{ port: number; addr: string; process: string }[]> {
  const r = await ssh.exec(ctrl as any, "ss -tlnH 2>/dev/null || netstat -tln 2>/dev/null", 8000)
  if (r.code !== 0) return []
  const seen = new Map<string, { port: number; addr: string; process: string }>()
  for (const raw of r.stdout.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    // ss -tlnH:  LISTEN 0  4096  0.0.0.0:80   0.0.0.0:*    users:(("nginx",pid=1,fd=6))
    // netstat:   tcp  0  0   0.0.0.0:80      0.0.0.0:*     LISTEN
    const cols = line.split(/\s+/)
    let listenCol = ''
    let proc = ''
    if (line.startsWith('LISTEN')) {
      listenCol = cols[3] ?? ''
      const m = raw.match(/\(\("([^"]+)"/)
      if (m) proc = m[1] ?? ''
    } else if (cols[0] === 'tcp' || cols[0] === 'tcp6') {
      if (!cols.includes('LISTEN')) continue
      listenCol = cols[3] ?? ''
    } else continue
    const colon = listenCol.lastIndexOf(':')
    if (colon < 0) continue
    const portNum = parseInt(listenCol.slice(colon + 1), 10)
    if (!Number.isFinite(portNum) || portNum <= 0 || portNum > 65535) continue
    const addr = listenCol.slice(0, colon)
    // Hide loopback-only services — not reachable from the user's browser anyway
    if (addr === '127.0.0.1' || addr === '[::1]' || addr === '::1') continue
    const key = `${portNum}`
    if (!seen.has(key)) seen.set(key, { port: portNum, addr, process: proc })
    else if (proc && !seen.get(key)!.process) seen.get(key)!.process = proc
  }
  return [...seen.values()].sort((a, b) => a.port - b.port)
}

function resolveBaseUrl(s: Settings): string | undefined {
  const cur = s.providers[s.provider]
  if (cur.baseURL && cur.baseURL.trim()) return cur.baseURL
  const def = PROVIDER_DEFAULTS[s.provider]?.baseURL
  return def || undefined
}

// Возврат seedSystemSkills используется в POST /api/chats: при создании чата
// юзеру в первой строке (system_event) показывается «Модель: X · инструменты:
// N · скиллы: M», а если M=0 — рядом ⚠ предупреждение о баге сборки. Так
// проблема видна в UI без копания в логах сервера.
seedSystemSkills(db)

const discovery = new Discovery(db)
let mqtt = new MqttPool({ user: settings.mqttUser, password: settings.mqttPassword })
const ssh = new SshPool({
  user: settings.sshUser,
  password: settings.sshPassword,
  keyPath: settings.sshKeyPath,
})
const chats = new ChatStore(db)
function buildLlmClient(s: Settings): LlmClient | null {
  const cur = s.providers[s.provider]
  if (!cur.apiKey) return null
  return new LlmClient({
    apiKey: cur.apiKey,
    baseURL: resolveBaseUrl(s),
    model: cur.model || 'gpt-4.1-mini',
    llmProxy: cur.llmProxy || undefined,
    llmProxyUser: cur.llmProxyUser || undefined,
    llmProxyPassword: cur.llmProxyPassword || undefined,
    tlsInsecure: cur.tlsInsecure,
    caCert: cur.caCert || undefined,
    apiFormat: cur.apiFormat,
    // OpenRouter возвращает usage.cost (USD) только если в теле явно
    // передан `usage: { include: true }`.
    includeUsageAccounting: s.provider === 'openrouter',
    // OpenRouter middle-out: серверное сжатие включается одной общей
    // галочкой autoCompact (как у AITunnel). autoCompact=off → серверное
    // сжатие провайдера; autoCompact=on → клиентский checkpoint, а
    // серверный middle-out отключён, чтобы не было двойной обработки.
    middleOut: s.provider === 'openrouter' && !cur.autoCompact,
    minRequestIntervalMs: cur.minRequestIntervalMs,
  })
}

let llm: LlmClient | null = buildLlmClient(settings)

settingsStore.onChange((s) => {
  llm = buildLlmClient(s)
  void mqtt.close()
  mqtt = new MqttPool({ user: s.mqttUser, password: s.mqttPassword })
  ssh.setAuth({ user: s.sshUser, password: s.sshPassword, keyPath: s.sshKeyPath })
})

discovery.start(settings.discoveryInterval)

// Background-poller, обновляющий состояние running-задач из памяти. UI
// poll читает уже актуальный state без блокирующего SSH в http-обработчике.
startJobTracker(async (job) => {
  const ctrl = discovery.get(job.sn)
  if (!ctrl) return null
  const r = await ssh.jobStatus(ctrl, job.jobId)
  return (r['state'] as 'running' | 'exited' | 'unknown') ?? null
}, 5000)

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
  const stringFields = ['apiKey', 'baseURL', 'model', 'llmProxy', 'llmProxyUser', 'llmProxyPassword', 'mqttUser', 'mqttPassword', 'sshUser', 'sshPassword', 'sshKeyPath', 'caCert', 'compactModel']
  for (const f of stringFields) {
    if (typeof body[f] === 'string') patch[f] = body[f]
  }
  if (typeof body['provider'] === 'string' && ['openai', 'aitunnel', 'openrouter', 'custom', 'custom_proxy'].includes(body['provider'] as string)) {
    patch['provider'] = body['provider']
  }
  if (typeof body['apiFormat'] === 'string' && ['openai'].includes(body['apiFormat'] as string)) {
    patch['apiFormat'] = body['apiFormat']
  }
  if (typeof body['discoveryInterval'] === 'number') patch['discoveryInterval'] = body['discoveryInterval']
  if (typeof body['openBrowser'] === 'boolean') patch['openBrowser'] = body['openBrowser']
  if (typeof body['tlsInsecure'] === 'boolean') patch['tlsInsecure'] = body['tlsInsecure']
  if (typeof body['autoCompact'] === 'boolean') patch['autoCompact'] = body['autoCompact']
  if (typeof body['autoCompactThreshold'] === 'number'
      && body['autoCompactThreshold'] >= 0.5
      && body['autoCompactThreshold'] < 1) {
    patch['autoCompactThreshold'] = body['autoCompactThreshold']
  }
  for (const f of ['priceInput', 'priceOutput', 'priceCached', 'contextWindow', 'temperature', 'minRequestIntervalMs']) {
    if (typeof body[f] === 'number' || body[f] === null) patch[f] = body[f]
  }
  await settingsStore.update(patch)
  if (typeof patch['discoveryInterval'] === 'number') {
    discovery.setInterval(patch['discoveryInterval'])
  }
  return c.json(settingsStore.toPublic())
})

app.get('/api/settings/export', () => {
  // Export EVERYTHING incl. secrets — assumed local-only. Don't share the file blindly.
  const s = settingsStore.get()
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  return new Response(JSON.stringify(s, null, 2), {
    headers: {
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="wb-ai-helper-settings-${ts}.json"`,
    },
  })
})

app.post('/api/settings/import', async (c) => {
  let body: unknown
  try { body = await c.req.json() } catch { return c.json({ error: 'invalid JSON' }, 400) }
  if (!body || typeof body !== 'object') return c.json({ error: 'object expected' }, 400)
  await settingsStore.update(body as Record<string, unknown>)
  if (typeof (body as any)['discoveryInterval'] === 'number') {
    discovery.setInterval((body as any)['discoveryInterval'])
  }
  return c.json(settingsStore.toPublic())
})

app.delete('/api/settings/api-key', async (c) => {
  await settingsStore.clearKey()
  return c.json(settingsStore.toPublic())
})

/**
 * AITunnel-specific: баланс + сводная статистика + email юзера. Доступно только
 * когда активный провайдер — `aitunnel` (используем его apiKey/baseURL).
 */
app.get('/api/aitunnel/info', async (c) => {
  const s = settingsStore.get()
  if (s.provider !== 'aitunnel') return c.json({ error: 'провайдер не aitunnel' }, 400)
  const cur = s.providers.aitunnel
  if (!cur.apiKey) return c.json({ error: 'apiKey не задан' }, 400)
  const root = (cur.baseURL || PROVIDER_DEFAULTS.aitunnel.baseURL).replace(/\/$/, '')
  const headers = { authorization: `Bearer ${cur.apiKey}` }
  try {
    const [balRes, statsRes, meRes] = await Promise.all([
      fetch(`${root}/aitunnel/balance`, { headers, signal: AbortSignal.timeout(10000) }),
      fetch(`${root}/aitunnel/stats/summary`, { headers, signal: AbortSignal.timeout(10000) }),
      fetch(`${root}/aitunnel/me`, { headers, signal: AbortSignal.timeout(10000) }),
    ])
    const [balance, stats, me] = await Promise.all([
      balRes.ok ? balRes.json().catch(() => null) : null,
      statsRes.ok ? statsRes.json().catch(() => null) : null,
      meRes.ok ? meRes.json().catch(() => null) : null,
    ])
    if (!balRes.ok) {
      const txt = await balRes.text().catch(() => '')
      return c.json({ error: `HTTP ${balRes.status}: ${txt.slice(0, 200)}` }, balRes.status as any)
    }
    return c.json({ balance, stats, me })
  } catch (e: any) {
    return c.json({ error: e?.message ?? String(e) }, 502)
  }
})

/**
 * OpenRouter-specific: total credits / total usage / лимиты ключа.
 * Доступно только когда активный провайдер — `openrouter`.
 */
app.get('/api/openrouter/info', async (c) => {
  const s = settingsStore.get()
  if (s.provider !== 'openrouter') return c.json({ error: 'провайдер не openrouter' }, 400)
  const cur = s.providers.openrouter
  if (!cur.apiKey) return c.json({ error: 'apiKey не задан' }, 400)
  const root = (cur.baseURL || PROVIDER_DEFAULTS.openrouter.baseURL).replace(/\/$/, '')
  const headers = { authorization: `Bearer ${cur.apiKey}` }
  try {
    const [creditsRes, keyRes] = await Promise.all([
      fetch(`${root}/credits`, { headers, signal: AbortSignal.timeout(10000) }),
      fetch(`${root}/auth/key`, { headers, signal: AbortSignal.timeout(10000) }),
    ])
    const [creditsBody, keyBody] = await Promise.all([
      creditsRes.ok ? creditsRes.json().catch(() => null) : null,
      keyRes.ok ? keyRes.json().catch(() => null) : null,
    ])
    if (!creditsRes.ok && !keyRes.ok) {
      const txt = await creditsRes.text().catch(() => '')
      return c.json({ error: `HTTP ${creditsRes.status}: ${txt.slice(0, 200)}` }, creditsRes.status as any)
    }
    return c.json({
      credits: (creditsBody as any)?.data ?? null,
      key: (keyBody as any)?.data ?? null,
    })
  } catch (e: any) {
    return c.json({ error: e?.message ?? String(e) }, 502)
  }
})

app.get('/api/models', async (c) => {
  const s = settingsStore.get()
  const cur = s.providers[s.provider]
  if (!cur.apiKey) return c.json({ error: 'apiKey не задан' }, 400)
  try {
    const items = await listModels(cur.apiKey, resolveBaseUrl(s), {
      proxy: cur.llmProxy || undefined,
      proxyUser: cur.llmProxyUser || undefined,
      proxyPassword: cur.llmProxyPassword || undefined,
      tlsInsecure: cur.tlsInsecure,
      caCert: cur.caCert || undefined,
    })
    const models = items.map((m) => m.id)
    const contextLengths: Record<string, number> = {}
    for (const m of items) {
      if (typeof m.contextLength === 'number') contextLengths[m.id] = m.contextLength
    }
    return c.json({ models, contextLengths })
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

app.get('/api/controllers/:sn/ports', async (c) => {
  const sn = c.req.param('sn')
  const ctrl = discovery.get(sn) ?? discovery.getOrCreate(sn)
  if (!ctrl) return c.json({ error: 'controller not found' }, 404)
  try {
    const ports = await listOpenPorts(ctrl)
    return c.json({ ports })
  } catch (e: unknown) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 502)
  }
})

app.get('/api/stats', (c) => c.json(chats.globalStats()))

app.get('/api/chats', (c) => c.json({ chats: chats.list() }))

app.post('/api/chats', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const chat = chats.create(body.title, Array.isArray(body.contextSns) ? body.contextSns : [])
  // Приветственный system_event с тем, что юзер должен видеть до первого
  // сообщения: что за модель, сколько инструментов и скиллов сейчас заряжено.
  // Тот же канал, что у уведомлений «джоба завершилась» (user-turn с префиксом
  // «[Система]» рендерится фронтом как ⚙ system_event). Если скиллов 0 —
  // сразу пишем предупреждение в этой же строке: иначе про багу сборки никто
  // не узнает (console.error на сервере в Electron-приложении не виден).
  const systemSkills = listSkills(db).filter((s) => s.origin === 'system').length
  const toolsCount = toolSchemas().length
  const settings = settingsStore.get()
  const providerLabel = PROVIDER_DEFAULTS[settings.provider]?.label ?? settings.provider
  const head = llm?.model
    ? `${providerLabel} · ${llm.model} · инструменты: ${toolsCount} · скиллы: ${systemSkills}`
    : `${providerLabel} (не настроен) · инструменты: ${toolsCount} · скиллы: ${systemSkills}`
  const warning = systemSkills === 0 ? ' ⚠ системные скиллы не загружены (бага сборки)' : ''
  chats.appendTurn(chat.id, { role: 'user', content: `[Система] ${head}${warning}` })
  return c.json(chats.get(chat.id))
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
  const id = c.req.param('id')
  chats.remove(id)
  // Drop user uploads + assistant-produced files for this chat
  clearAttachmentSession(id)
  return c.json({ ok: true })
})

app.get('/api/chats/:id/jobs', (c) => {
  const id = c.req.param('id')
  // ВАЖНО: не дёргаем SSH из этого endpoint. Раньше на каждый polling
  // (раз в 3 сек) делали `ssh.jobStatus(ctrl, jobId)` для всех running —
  // и когда контроллер был недоступен (например, во время `apt upgrade`
  // с обновлением ядра и reboot), SSH висел до handshake-таймаута,
  // параллельные запросы с разных тиков пересекались, баннер мерцал/пропадал.
  // Состояние job обновляется штатно — когда модель вызывает `job_status`
  // как tool (см. tools.ts), это транзитом дёргает updateJobState.
  return c.json({ jobs: getJobsForSession(id) })
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
  const retryLast = body && body.retryLast === true
  if (!retryLast && !userText) return c.json({ error: 'text required' }, 400)
  const compactRequested = body && body.compact === true
  // Override the model only when the caller requested compaction AND a separate
  // compactModel is configured for this provider — otherwise stay on the main model.
  const cur = settingsStore.current()
  const modelOverride = compactRequested && cur.compactModel ? cur.compactModel : undefined
  const temperatureOverride =
    typeof cur.temperature === 'number' && Number.isFinite(cur.temperature)
      ? cur.temperature
      : undefined

  // retryLast: не добавляем user-turn повторно — берём последний из DB.
  // Используется кнопкой «Повторить» в баннере ошибок: текст уже сохранён
  // в чате при первой попытке, дубль не нужен.
  const chatWithUser = retryLast
    ? chats.get(id)!
    : chats.appendTurn(id, { role: 'user', content: userText })!

  return stream(c, async (s) => {
    const send = (event: string, data: unknown) => s.write(formatSse(event, data))
    await send('user', { text: userText })

    const agentState: { checkpointSummary?: string } = {}
    const ctx = { discovery, mqtt, ssh, contextSns: chat.contextSns, db, sessionId: id, agentState, braveApiKey: process.env['BRAVE_SEARCH_API_KEY'] }
    let assistantText = ''
    const pendingToolCalls: { id: string; name: string; arguments: string }[] = []
    let pendingUsage: { promptTokens?: number; completionTokens?: number; cachedTokens?: number; totalCost?: number } | null = null
    let finishReason: string | null = null

    try {
      for await (const ev of activeLlm.runAgent(
        chatWithUser.turns,
        toolSchemas(),
        (name, args) => dispatch(name, args, ctx),
        {
          maxTurns: 20,
          agentState,
          modelOverride,
          temperature: temperatureOverride,
          // Vision: при отправке user-сообщения с прикреплёнными
          // картинками llm.ts превратит токены `[file:id:name]` для
          // image-расширений в multi-modal content (image_url + base64).
          // Если модель не vision-capable, провайдер вернёт ошибку —
          // formatLlmError её распарсит для пользователя.
          loadAttachmentBuffer: (id: string) => {
            const meta = getAttachment(id, id) ?? getAttachment(chat.id, id)
            const buf = readAttachment(chat.id, id)
            if (!buf) return null
            return { buffer: buf, mime: meta?.mime ?? 'application/octet-stream' }
          },
          getExtraSystemMsgs: () => {
            const skills = listSkills(db)
            const catalog = skills.length
              ? skills.map((s) => `- ${s.name} — ${s.description}`).join('\n')
              : '(нет доступных скиллов)'
            const todos = getTodos(id)
            const loadedSkills = getLoadedSkills(id)
            // Only user uploads are shown to the LLM — assistant-produced files
            // are already covered by the tool result that created them.
            const attachments = listAttachmentFiles(id, 'user')
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
          pendingUsage = {
            promptTokens: ev.promptTokens,
            completionTokens: ev.completionTokens,
            cachedTokens: ev.cachedTokens,
            ...(ev.totalCost != null ? { totalCost: ev.totalCost } : {}),
          }
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
        if (ev.type === 'done') finishReason = ev.finish_reason
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
    // Если агент упёрся в max_turns без финального текста — пишем явное
    // системное сообщение, чтобы пользователь не сидел перед пустым чатом.
    if (finishReason === 'max_turns' && !assistantText) {
      const hint = 'Агент исчерпал бюджет шагов (20 итераций) и не успел подвести итог. Скажи «продолжай» — я продолжу с того места, или переформулируй задачу.'
      chats.appendTurn(id, { role: 'assistant', content: hint })
      await send('text-delta', { text: hint })
    }
    await send('end', { chatId: id })
  }, async (err, s) => {
    await s.write(formatSse('error', { message: String(err) }))
  })
})

app.get('/api/events', (c) => {
  // Hono's stream() defaults to text/plain — Chrome's EventSource refuses
  // anything that isn't text/event-stream and silently aborts.
  c.header('Content-Type', 'text/event-stream')
  c.header('Cache-Control', 'no-cache, no-transform')
  c.header('X-Accel-Buffering', 'no')
  return stream(c, async (s) => {
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
  })
})

// Attachments API
app.get('/api/attachments', (c) => {
  const chatId = c.req.query('chatId') ?? ''
  const source = c.req.query('source') as 'user' | 'assistant' | undefined
  if (!chatId) return c.json({ error: 'chatId required' }, 400)
  // Default — return ALL files (used by the chat header popup).
  // The input strip on the bottom asks for `?source=user` so it doesn't echo
  // assistant-produced files back into the next prompt.
  return c.json({ items: listAttachmentFiles(chatId, source) })
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

interface ShellSession {
  shell: { write: (s: string) => void; resize: (c: number, r: number) => void; close: () => void }
}

const server = Bun.serve<ShellSession, never>({
  port: PORT,
  hostname: '127.0.0.1',
  // Bun's default 10s idleTimeout rips long-lived SSE streams mid-flight
  // (tool-calling LLM turns easily exceed 10s between tokens). 0 disables it;
  // browser-side timeouts still apply.
  idleTimeout: 0,
  async fetch(req, srv) {
    const url = new URL(req.url)
    // SSH terminal: ws upgrade at /api/ssh/<sn>/shell
    const sshMatch = url.pathname.match(/^\/api\/ssh\/([^/]+)\/shell$/)
    if (sshMatch && req.headers.get('upgrade') === 'websocket') {
      const sn = decodeURIComponent(sshMatch[1]!)
      const ctrl = discovery.get(sn) ?? discovery.getOrCreate(sn)
      if (!ctrl) return new Response('controller not found', { status: 404 })
      // Stash sn on the WS so `open` can spin up the SSH shell asynchronously
      const ok = srv.upgrade(req, { data: { shell: undefined as unknown as ShellSession['shell'] }, headers: { 'X-WB-Controller': sn } })
      if (!ok) return new Response('upgrade failed', { status: 500 })
      return undefined
    }
    return app.fetch(req, srv)
  },
  websocket: {
    async open(ws) {
      // The handshake didn't have access to the SN reliably; pull it back from the path
      // by examining the upgrade headers. As a fallback we keep `data.sn` if set.
      const url = new URL(`http://x${ws.data ? '' : ''}`)
      void url
      const sn = (ws.remoteAddress, '') // placeholder
      void sn
    },
    async message(ws, message) {
      try {
        const text = typeof message === 'string' ? message : message.toString('utf8')
        const msg = JSON.parse(text) as
          | { t: 'init'; sn: string; cols: number; rows: number }
          | { t: 'data'; d: string }
          | { t: 'resize'; cols: number; rows: number }
        if (msg.t === 'init') {
          const ctrl = discovery.get(msg.sn) ?? discovery.getOrCreate(msg.sn)
          if (!ctrl) { ws.send(JSON.stringify({ t: 'error', e: 'controller not found' })); ws.close(); return }
          try {
            const shell = await ssh.openShell(ctrl,
              (chunk) => { try { ws.send(JSON.stringify({ t: 'data', d: chunk.toString('utf8') })) } catch { /* */ } },
              () => { try { ws.send(JSON.stringify({ t: 'close' })); ws.close() } catch { /* */ } },
              msg.cols, msg.rows,
            )
            ws.data.shell = shell
            ws.send(JSON.stringify({ t: 'ready' }))
          } catch (e: unknown) {
            ws.send(JSON.stringify({ t: 'error', e: e instanceof Error ? e.message : String(e) }))
            ws.close()
          }
          return
        }
        if (msg.t === 'data' && ws.data.shell) {
          ws.data.shell.write(msg.d)
        } else if (msg.t === 'resize' && ws.data.shell) {
          ws.data.shell.resize(msg.cols, msg.rows)
        }
      } catch (e: unknown) {
        try { ws.send(JSON.stringify({ t: 'error', e: e instanceof Error ? e.message : String(e) })) } catch { /* */ }
      }
    },
    close(ws) {
      ws.data.shell?.close()
    },
  },
})

console.log(`WB Helper запущен:          http://${server.hostname}:${server.port}/`)
console.log(`Настройки:                  ${settingsStore.storagePath()}`)
console.log(`LLM:                        ${llm ? `${llm.model} (${PROVIDER_DEFAULTS[settings.provider].label})` : 'не настроен — введите ключ через UI'}`)
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
