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
  | { role: 'assistant'; content: string; toolCalls?: AssistantToolCall[]; tokensPrompt?: number; tokensCompletion?: number }
  | { role: 'tool'; toolCallId: string; content: string }
  | { role: 'system'; content: string }

export type Chat = {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  contextSns: string[]
  turns: ChatTurn[]
  tokensPrompt: number
  tokensCompletion: number
}

export type TokenStats = {
  totalPromptTokens: number
  totalCompletionTokens: number
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
  mqttUser: string
  sshUser: string
  sshKeyPath: string
  discoveryInterval: number
  openBrowser: boolean
  apiKeyConfigured: boolean
  mqttPasswordConfigured: boolean
  sshPasswordConfigured: boolean
  storagePath: string
}

export type SettingsPatch = Partial<{
  apiKey: string
  baseURL: string
  model: string
  mqttUser: string
  mqttPassword: string
  sshUser: string
  sshPassword: string
  sshKeyPath: string
  discoveryInterval: number
  openBrowser: boolean
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
          onEvent(ev, JSON.parse(e.data))
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
