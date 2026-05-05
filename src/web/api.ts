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
  | { role: 'assistant'; content: string; toolCalls?: AssistantToolCall[]; tokensPrompt?: number; tokensCompletion?: number; tokensCached?: number }
  | { role: 'tool'; toolCallId: string; content: string }
  | { role: 'system'; content: string }

// ── Chat items (UI layer, derived from ChatTurn[]) ────────────────────────
export type ChatItemUser = { type: 'user'; text: string }
export type ChatItemAssistantText = { type: 'assistant_text'; text: string; tokensPrompt?: number; tokensCompletion?: number; tokensCached?: number }
export type ChatItemToolCall = { type: 'tool_call'; id: string; name: string; input: Record<string, unknown>; result?: { content: string; isError: boolean } }
export type ChatItemAssistantFile = { type: 'assistant_file'; attachmentId: string; name: string; mime: string; size: number; url: string; sourceSn?: string; sourcePath?: string }
export type ChatItemError = { type: 'error'; message: string }
export type ChatItem = ChatItemUser | ChatItemAssistantText | ChatItemToolCall | ChatItemAssistantFile | ChatItemError

export function turnsToItems(turns: ChatTurn[], chatId: string): ChatItem[] {
  const items: ChatItem[] = []
  const byCallId = new Map<string, { item: ChatItemToolCall; itemIdx: number }>()

  for (let i = 0; i < turns.length; i++) {
    const t = turns[i]!
    if (t.role === 'user') {
      items.push({ type: 'user', text: t.content })
    } else if (t.role === 'assistant') {
      for (const tc of t.toolCalls ?? []) {
        let input: Record<string, unknown> = {}
        try { input = JSON.parse(tc.arguments) } catch {}
        const item: ChatItemToolCall = { type: 'tool_call', id: tc.id, name: tc.name, input }
        byCallId.set(tc.id, { item, itemIdx: items.length })
        items.push(item)
      }
      if (t.content) {
        items.push({ type: 'assistant_text', text: t.content, tokensPrompt: t.tokensPrompt, tokensCompletion: t.tokensCompletion, tokensCached: t.tokensCached })
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
}

export type TokenStats = {
  totalPromptTokens: number
  totalCompletionTokens: number
  totalCachedTokens?: number
}

export type Health = {
  ok: boolean
  version: string
  llmConfigured: boolean
  model: string | null
  port: number
  discoveryInterval: number
}

export type Settings = {
  baseURL: string
  model: string
  llmProxy: string
  tlsInsecure: boolean
  mqttUser: string
  sshUser: string
  sshKeyPath: string
  discoveryInterval: number
  openBrowser: boolean
  apiKeyConfigured: boolean
  mqttPasswordConfigured: boolean
  sshPasswordConfigured: boolean
  storagePath: string
  priceInput?: number | null
  priceOutput?: number | null
  priceCached?: number | null
}

export type SettingsPatch = Partial<{
  apiKey: string
  baseURL: string
  model: string
  llmProxy: string
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
  models: () => fetch('/api/models').then((r) => json<{ models: string[] }>(r)),
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

  /** Send a message and stream SSE events. */
  sendMessage(
    id: string,
    text: string,
    onEvent: (event: string, data: any) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    return fetch(`/api/chats/${id}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
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

export function calcCost(
  promptTokens: number,
  completionTokens: number,
  cachedTokens: number,
  prices: { priceInput?: number | null; priceOutput?: number | null; priceCached?: number | null },
): number | null {
  if (prices.priceInput == null && prices.priceOutput == null) return null
  const input = (promptTokens - cachedTokens) * (prices.priceInput ?? 0) / 1_000_000
  const cached = cachedTokens * (prices.priceCached ?? prices.priceInput ?? 0) / 1_000_000
  const output = completionTokens * (prices.priceOutput ?? 0) / 1_000_000
  return input + cached + output
}
