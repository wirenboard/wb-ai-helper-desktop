export type Controller = {
  sn: string
  host: string
  addresses: string[]
  port?: number
  lastSeen: number
  source: 'mdns' | 'manual'
  reachable?: boolean
  fw?: string
  hostname?: string
}

export type AssistantToolCall = { id: string; name: string; arguments: string }

export type ChatTurn =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; createdAt?: number; toolCalls?: AssistantToolCall[]; tokensPrompt?: number; tokensCompletion?: number; tokensCached?: number; tokensCost?: number }
  | { role: 'tool'; toolCallId: string; content: string }
  | { role: 'system'; content: string }

// ── Chat items (UI layer, derived from ChatTurn[]) ────────────────────────
export type ChatItemUserAttachment = { id: string; name: string; isImage: boolean }
export type ChatItemUser = { type: 'user'; text: string; attachments?: ChatItemUserAttachment[] }
export type ChatItemAssistantText = { type: 'assistant_text'; text: string; createdAt?: number; tokensPrompt?: number; tokensCompletion?: number; tokensCached?: number; tokensCost?: number }
export type ChatItemToolCall = { type: 'tool_call'; id: string; name: string; input: Record<string, unknown>; result?: { content: string; isError: boolean } }
export type ChatItemAssistantFile = { type: 'assistant_file'; attachmentId: string; name: string; mime: string; size: number; url: string; sourceSn?: string; sourcePath?: string }
export type ChatItemError = { type: 'error'; message: string }
export type ChatItemSystemEvent = { type: 'system_event'; text: string }
export type ChatItem = ChatItemUser | ChatItemAssistantText | ChatItemToolCall | ChatItemAssistantFile | ChatItemError | ChatItemSystemEvent

export function turnsToItems(turns: ChatTurn[], chatId: string): ChatItem[] {
  const items: ChatItem[] = []
  const byCallId = new Map<string, { item: ChatItemToolCall; itemIdx: number }>()

  for (let i = 0; i < turns.length; i++) {
    const t = turns[i]!
    if (t.role === 'user') {
      if (t.content.startsWith('[Система]')) {
        items.push({ type: 'system_event', text: t.content.slice('[Система]'.length).trim().split('\n')[0]! })
        continue
      }
      // Парсим токены вложений `[file:id:name]` (вставляются ChatInputArea
      // при отправке). Image-расширения помечаем для рендера thumbnail.
      const attachments: ChatItemUserAttachment[] = []
      const text = t.content.replace(/\[file:([^:\]]+):([^\]]+)\]\s*/g, (_match, id: string, name: string) => {
        attachments.push({ id, name, isImage: /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(name) })
        return ''
      }).trim()
      items.push(attachments.length
        ? { type: 'user', text, attachments }
        : { type: 'user', text })
    } else if (t.role === 'assistant') {
      for (const tc of t.toolCalls ?? []) {
        let input: Record<string, unknown> = {}
        try { input = JSON.parse(tc.arguments) } catch {}
        const item: ChatItemToolCall = { type: 'tool_call', id: tc.id, name: tc.name, input }
        byCallId.set(tc.id, { item, itemIdx: items.length })
        items.push(item)
      }
      if (t.content) {
        items.push({ type: 'assistant_text', text: t.content, createdAt: t.createdAt, tokensPrompt: t.tokensPrompt, tokensCompletion: t.tokensCompletion, tokensCached: t.tokensCached, tokensCost: t.tokensCost })
      }
    } else if (t.role === 'tool') {
      const callId = (t as { toolCallId?: string }).toolCallId
      if (t.content.startsWith('▶ ')) {
        const lines = t.content.split('\n')
        const name = lines[0]!.slice(2).trim()
        const errSepIdx = lines.indexOf('— result err —')
        const okSepIdx = lines.indexOf('— result —')
        const sepIdx = errSepIdx >= 0 ? errSepIdx : okSepIdx
        const isErr = errSepIdx >= 0
        const argsStr = sepIdx > 1 ? lines.slice(1, sepIdx).join('\n') : sepIdx === -1 ? lines.slice(1).join('\n') : ''
        const resultStr = sepIdx >= 0 ? lines.slice(sepIdx + 1).join('\n') : undefined
        let input: Record<string, unknown> = {}
        try { input = JSON.parse(argsStr) } catch {}
        const id = callId ?? `stream-${i}`
        const item: ChatItemToolCall = { type: 'tool_call', id, name, input, result: resultStr !== undefined ? { content: resultStr, isError: isErr } : undefined }
        byCallId.set(id, { item, itemIdx: items.length })
        items.push(item)
      } else if (callId) {
        const entry = byCallId.get(callId)
        if (entry) {
          const isErr = t.content.startsWith('\x01')
          entry.item.result = { content: isErr ? t.content.slice(1) : t.content, isError: isErr }
        }
      }
    }
  }

  // Insert assistant_file items after tool_calls that returned a file attachment
  const inserts: Array<{ at: number; item: ChatItemAssistantFile }> = []
  for (let i = 0; i < items.length; i++) {
    const it = items[i]!
    if (it.type !== 'tool_call' || !it.result) continue
    try {
      const p = JSON.parse(it.result.content)
      if (typeof p.fileId === 'string' && p.fileName) {
        inserts.push({ at: i + 1, item: { type: 'assistant_file', attachmentId: p.fileId, name: p.fileName, mime: p.mime ?? 'application/octet-stream', size: p.size ?? 0, url: `/api/attachments/${encodeURIComponent(p.fileId)}?chatId=${encodeURIComponent(chatId)}` } })
      }
    } catch {}
  }
  for (let i = inserts.length - 1; i >= 0; i--) items.splice(inserts[i]!.at, 0, inserts[i]!.item)

  return items
}

export type Chat = {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  contextSns: string[]
  turns: ChatTurn[]
  tokensPrompt: number
  tokensCompletion: number
  tokensCached: number
  totalCost: number
}

export type TokenStats = {
  totalPromptTokens: number
  totalCompletionTokens: number
  totalCachedTokens?: number
  totalCost?: number
}

export type TrackedJob = {
  jobId: string
  sn: string
  label: string
  sessionId: string
  state: 'running' | 'exited' | 'unknown'
}

export type Health = {
  ok: boolean
  version: string
  llmConfigured: boolean
  model: string | null
  port: number
  discoveryInterval: number
}

export type LlmProvider = 'openai' | 'aitunnel' | 'openrouter' | 'custom' | 'custom_proxy'
export type ApiFormat = 'openai'

export interface ProviderInfo {
  label: string
  defaultBaseURL: string
  currency: 'USD' | 'RUB' | null
  pricesEditable: boolean
  /** Where the user can sign up / get an API key. Shown as "Получить ключ ↗". */
  signupUrl: string | null
}

export const PROVIDER_INFO: Record<LlmProvider, ProviderInfo & { apiFormat: ApiFormat; baseURLEditable: boolean; supportsCaCert: boolean; apiFormatEditable: boolean }> = {
  openai: {
    label: 'OpenAI',
    defaultBaseURL: 'https://api.openai.com/v1',
    currency: 'USD',
    pricesEditable: true,
    signupUrl: 'https://platform.openai.com/api-keys',
    apiFormat: 'openai',
    baseURLEditable: false,
    supportsCaCert: false,
    apiFormatEditable: false,
  },
  aitunnel: {
    label: 'AITunnel',
    defaultBaseURL: 'https://api.aitunnel.ru/v1',
    currency: 'RUB',
    // aitunnel сам считает стоимость в каждом ответе (usage.cost_rub) —
    // ручные цены не нужны.
    pricesEditable: false,
    signupUrl: 'https://aitunnel.ru/',
    apiFormat: 'openai',
    baseURLEditable: false,
    supportsCaCert: false,
    apiFormatEditable: false,
  },
  openrouter: {
    label: 'OpenRouter',
    defaultBaseURL: 'https://openrouter.ai/api/v1',
    currency: 'USD',
    // OpenRouter возвращает usage.cost — ручные цены не нужны.
    pricesEditable: false,
    signupUrl: 'https://openrouter.ai/keys',
    apiFormat: 'openai',
    baseURLEditable: false,
    supportsCaCert: false,
    apiFormatEditable: false,
  },
  custom: {
    label: 'Custom',
    defaultBaseURL: '',
    currency: null,
    pricesEditable: false,
    signupUrl: null,
    apiFormat: 'openai',
    baseURLEditable: true,
    supportsCaCert: false,
    apiFormatEditable: false,
  },
  custom_proxy: {
    label: 'Custom AI Proxy',
    defaultBaseURL: '',
    currency: null,
    pricesEditable: false,
    signupUrl: null,
    apiFormat: 'openai',
    baseURLEditable: true,
    supportsCaCert: true,
    apiFormatEditable: false,
  },
}

/**
 * GitHub Copilot premium-request multipliers for the chat-completions
 * compatible whitelist. Shown as a small badge in the model picker so
 * the user can pick a "free" tier (0×) over a 5× one.
 */
export const COPILOT_MULTIPLIERS: Record<string, string> = {
  'gpt-4o-mini':       '0×',
  'gpt-4.1-mini':      '0×',
  'gpt-4o':            '0×',
  'gpt-4.1':           '0×',
  'grok-code-fast-1':  '0×',
  'claude-haiku-4.5':  '0.33×',
  'claude-sonnet-4.5': '1×',
  'claude-sonnet-4.6': '1×',
  'claude-opus-4.5':   '5×',
  'claude-opus-4.7':   '5×',
}

/**
 * Известные размеры контекстного окна по имени модели. UI показывает
 * заполнение `↑X / 128k` в шапке чата. Юзер может переопределить через
 * ProviderConfig.contextWindow.
 */
export const MODEL_CONTEXT: Record<string, number> = {
  // OpenAI
  'gpt-4o':              128_000,
  'gpt-4o-mini':         128_000,
  'gpt-4o-2024-08-06':   128_000,
  'gpt-4o-2024-05-13':   128_000,
  'gpt-4o-2024-11-20':   128_000,
  'gpt-4.1':            1_000_000,
  'gpt-4.1-mini':       1_000_000,
  'gpt-4.1-2025-04-14': 1_000_000,
  'gpt-4':                  8_192,
  'gpt-4-turbo':          128_000,
  'gpt-3.5-turbo':         16_385,
  'gpt-3.5-turbo-0613':     4_096,
  // gpt-5.x (Copilot proxy / preview)
  'gpt-5':              400_000,
  'gpt-5-mini':         400_000,
  'gpt-5.2':            400_000,
  'gpt-5.4':            400_000,
  'gpt-5.4-mini':       400_000,
  'gpt-5.5':            400_000,
  'gpt-5.3-codex':      400_000,
  'gpt-5.2-codex':      400_000,
  // Claude (через MITM-прокси, OpenAI-совместимый формат)
  'claude-haiku-4.5':    200_000,
  'claude-sonnet-4':     200_000,
  'claude-sonnet-4.5':   200_000,
  'claude-sonnet-4.6':   200_000,
  'claude-opus-4.5':     200_000,
  'claude-opus-4.7':     200_000,
  // Прочее
  'gemini-2.5-pro':        1_000_000,
  'gemini-3.1-pro-preview':2_000_000,
  'grok-code-fast-1':        256_000,
}

/** Разумный дефолт когда конкретная модель не в таблице. 128k — медиана для
 * современных чат-моделей. Юзер может переопределить через ProviderConfig.contextWindow. */
const DEFAULT_CONTEXT_WINDOW = 128_000

export function contextWindowOf(model: string, override?: number | null): number {
  if (typeof override === 'number' && override > 0) return override
  if (!model) return DEFAULT_CONTEXT_WINDOW
  return MODEL_CONTEXT[model] ?? DEFAULT_CONTEXT_WINDOW
}

export type ProviderConfigPublic = {
  baseURL: string
  model: string
  llmProxy: string
  llmProxyUser: string
  tlsInsecure: boolean
  caCert: string
  apiFormat: ApiFormat
  priceInput: number | null
  priceOutput: number | null
  priceCached: number | null
  contextWindow: number | null
  /** Опциональная (обычно более дешёвая) модель для сжатия контекста.
   * Пустая строка → используется основная `model`. */
  compactModel: string
  /** Авто-сжатие при заполнении контекстного окна (per-provider). */
  autoCompact: boolean
  /** Порог заполнения контекстного окна (0..1) для автосжатия (per-provider). */
  autoCompactThreshold: number
  /** Sampling temperature override (per-provider). null = use provider default. */
  temperature: number | null
  /** Минимальный интервал между запросами к провайдеру, мс. null = нет троттлинга. */
  minRequestIntervalMs: number | null
  apiKeyConfigured: boolean
  llmProxyPasswordConfigured: boolean
}

export type Settings = {
  provider: LlmProvider
  /** Per-provider configs; the active one is providers[provider]. */
  providers: Record<LlmProvider, ProviderConfigPublic>
  // Flat view of the *current* provider — these are the same as providers[provider].
  baseURL: string
  model: string
  llmProxy: string
  llmProxyUser: string
  tlsInsecure: boolean
  apiKeyConfigured: boolean
  llmProxyPasswordConfigured: boolean
  priceInput?: number | null
  priceOutput?: number | null
  priceCached?: number | null
  contextWindow?: number | null
  compactModel?: string
  autoCompact: boolean
  autoCompactThreshold: number
  temperature?: number | null
  minRequestIntervalMs?: number | null
  // Shared (controller / UI):
  mqttUser: string
  sshUser: string
  sshKeyPath: string
  discoveryInterval: number
  openBrowser: boolean
  mqttPasswordConfigured: boolean
  sshPasswordConfigured: boolean
  storagePath: string
}

export type SettingsPatch = Partial<{
  provider: LlmProvider
  apiKey: string
  baseURL: string
  model: string
  llmProxy: string
  llmProxyUser: string
  llmProxyPassword: string
  tlsInsecure: boolean
  mqttUser: string
  mqttPassword: string
  sshUser: string
  sshPassword: string
  sshKeyPath: string
  discoveryInterval: number
  openBrowser: boolean
  priceInput: number | null
  priceOutput: number | null
  priceCached: number | null
  contextWindow: number | null
  compactModel: string
  autoCompact: boolean
  autoCompactThreshold: number
  temperature: number | null
  minRequestIntervalMs: number | null
}>

const json = async <T>(res: Response): Promise<T> => {
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText)
    throw new Error(text || `HTTP ${res.status}`)
  }
  return (await res.json()) as T
}

export const api = {
  health: () => fetch('/api/health').then((r) => json<Health>(r)),
  settings: () => fetch('/api/settings').then((r) => json<Settings>(r)),
  saveSettings: (patch: SettingsPatch) =>
    fetch('/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    }).then((r) => json<Settings>(r)),
  clearApiKey: () =>
    fetch('/api/settings/api-key', { method: 'DELETE' }).then((r) => json<Settings>(r)),
  models: () => fetch('/api/models').then((r) => json<{ models: string[]; contextLengths?: Record<string, number> }>(r)),
  aitunnelInfo: () => fetch('/api/aitunnel/info').then((r) => json<AitunnelInfo>(r)),
  openrouterInfo: () => fetch('/api/openrouter/info').then((r) => json<OpenRouterInfo>(r)),
  controllers: () => fetch('/api/controllers').then((r) => json<{ controllers: Controller[] }>(r)),
  refresh: () =>
    fetch('/api/controllers/refresh', { method: 'POST' }).then((r) =>
      json<{ controllers: Controller[] }>(r),
    ),
  addController: (host: string) =>
    fetch('/api/controllers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ host }),
    }).then((r) => json<Controller>(r)),
  removeController: (sn: string) =>
    fetch(`/api/controllers/${encodeURIComponent(sn)}`, { method: 'DELETE' }).then((r) =>
      json<{ ok: true }>(r),
    ),

  stats: () => fetch('/api/stats').then((r) => json<TokenStats>(r)),

  chatJobs: (chatId: string) =>
    fetch(`/api/chats/${encodeURIComponent(chatId)}/jobs`).then((r) => json<{ jobs: TrackedJob[] }>(r)),
  cancelJob: (chatId: string, jobId: string) =>
    fetch(`/api/chats/${encodeURIComponent(chatId)}/jobs/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' }).then((r) => json<{ ok: boolean; jobId: string }>(r)),

  chats: () => fetch('/api/chats').then((r) => json<{ chats: Chat[] }>(r)),
  createChat: (contextSns: string[] = [], title?: string) =>
    fetch('/api/chats', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contextSns, title }),
    }).then((r) => json<Chat>(r)),
  getChat: (id: string) => fetch(`/api/chats/${id}`).then((r) => json<Chat>(r)),
  patchChat: (id: string, body: { title?: string; contextSns?: string[] }) =>
    fetch(`/api/chats/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => json<Chat>(r)),
  deleteChat: (id: string) =>
    fetch(`/api/chats/${id}`, { method: 'DELETE' }).then((r) => json<{ ok: true }>(r)),

  deleteAttachment: (chatId: string, attachmentId: string) =>
    fetch(`/api/attachments/${encodeURIComponent(attachmentId)}?chatId=${encodeURIComponent(chatId)}`, { method: 'DELETE' })
      .then((r) => json<{ ok: true }>(r)),

  /** Send a message and stream SSE events.
   * `compact: true` сигнализирует backend использовать configured `compactModel`
   * (если задан) для этого вызова — вместо основной модели.
   * `retryLast: true` — backend НЕ добавляет user-turn повторно (использует
   * последний из DB), text может быть пустым. Используется кнопкой
   * «Повторить» в баннере ошибок. */
  sendMessage(
    id: string,
    text: string,
    onEvent: (event: string, data: any) => void,
    signal?: AbortSignal,
    opts?: { compact?: boolean; retryLast?: boolean },
  ): Promise<void> {
    return fetch(`/api/chats/${id}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text,
        ...(opts?.compact ? { compact: true } : {}),
        ...(opts?.retryLast ? { retryLast: true } : {}),
      }),
      signal,
    }).then(async (res) => {
      if (!res.ok) {
        const txt = await res.text().catch(() => res.statusText)
        throw new Error(txt || `HTTP ${res.status}`)
      }
      const reader = res.body?.getReader()
      if (!reader) return
      const dec = new TextDecoder()
      let buf = ''
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        let idx
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, idx)
          buf = buf.slice(idx + 2)
          let event = 'message'
          let data = ''
          for (const line of block.split('\n')) {
            if (line.startsWith('event: ')) event = line.slice(7).trim()
            else if (line.startsWith('data: ')) data += line.slice(6)
          }
          if (data) {
            try {
              onEvent(event, JSON.parse(data))
            } catch {
              onEvent(event, data)
            }
          }
        }
      }
    })
  },

  /** Subscribe to global events (controller list updates). */
  subscribeEvents(onEvent: (event: string, data: any) => void): () => void {
    const es = new EventSource('/api/events')
    const handlers: { type: string; fn: (e: MessageEvent) => void }[] = []
    for (const ev of ['hello', 'controllers', 'ping']) {
      const fn = (e: MessageEvent) => {
        try {
          onEvent(ev, JSON.parse(e.data as string))
        } catch {
          onEvent(ev, e.data)
        }
      }
      es.addEventListener(ev, fn)
      handlers.push({ type: ev, fn })
    }
    return () => {
      for (const { type, fn } of handlers) es.removeEventListener(type, fn)
      es.close()
    }
  },
}

export type AitunnelInfo = {
  balance: { balance: number; budget: number } | null
  stats: {
    today_spend: number
    today_requests: number
    month_spend: number
    month_requests: number
    avg_daily_spend: number
    top_model_by_spend: string
    top_model_by_spend_value: number
    top_model_by_requests: string
    top_model_by_requests_value: number
  } | null
  me: { email: string; id: number } | null
}

export type OpenRouterInfo = {
  credits: { total_credits: number; total_usage: number } | null
  key: {
    label?: string
    usage?: number
    limit?: number | null
    limit_remaining?: number | null
    is_free_tier?: boolean
    is_provisioning_key?: boolean
    rate_limit?: { requests: number; interval: string }
  } | null
}

export type Cost = { value: number; currency: 'USD' | 'RUB' }

/**
 * Compute display-ready cost for a turn or chat.
 *
 * Strategy depends on the provider:
 *  - VseGPT (and any provider that returns `usage.total_cost`): use `tokensCost` directly. RUB.
 *  - OpenAI / Custom-with-prices: compute from settings.priceInput/Output/Cached. USD.
 *  - Custom without prices: no cost.
 */
export function calcCost(
  promptTokens: number,
  completionTokens: number,
  cachedTokens: number,
  source: {
    provider?: LlmProvider
    tokensCost?: number
    priceInput?: number | null
    priceOutput?: number | null
    priceCached?: number | null
  },
): Cost | null {
  // Provider returned the cost server-side (VseGPT)
  if (typeof source.tokensCost === 'number' && source.tokensCost > 0) {
    const currency = source.provider ? (PROVIDER_INFO[source.provider].currency ?? 'RUB') : 'RUB'
    return { value: source.tokensCost, currency }
  }
  // Provider doesn't expose prices — nothing to compute
  if (source.provider && !PROVIDER_INFO[source.provider].pricesEditable) return null
  // Need at least one price to estimate
  if (source.priceInput == null && source.priceOutput == null) return null
  const input = (promptTokens - cachedTokens) * (source.priceInput ?? 0) / 1_000_000
  const cached = cachedTokens * (source.priceCached ?? source.priceInput ?? 0) / 1_000_000
  const output = completionTokens * (source.priceOutput ?? 0) / 1_000_000
  return { value: input + cached + output, currency: 'USD' }
}
