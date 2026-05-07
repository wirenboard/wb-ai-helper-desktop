import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

export type LlmProvider = 'openai' | 'aitunnel' | 'custom' | 'custom_proxy'
/** Только OpenAI Chat Completions сейчас. Anthropic-формат вырезан, оставлено
 * поле для будущего — Responses API или ещё какие protocol-варианты. */
export type ApiFormat = 'openai'

/** All LLM-side settings live here, one set per provider. */
export interface ProviderConfig {
  apiKey: string
  baseURL: string
  model: string
  llmProxy: string
  llmProxyUser: string
  llmProxyPassword: string
  tlsInsecure: boolean
  /** PEM-содержимое CA-сертификата для доступа через MITM-прокси (e.g. Claude proxy). */
  caCert: string
  /** Override known model context window in tokens (manual). null = use static MODEL_CONTEXT
   * fallback / auto-detected provider value. */
  contextWindow: number | null
  /** Опциональная (обычно более дешёвая) модель для сжатия контекста через checkpoint.
   * Пусто → используется основная `model`. */
  compactModel: string
  /** Автоматически вызывать checkpoint когда заполнение контекстного окна
   * превышает порог (см. `autoCompactThreshold`). */
  autoCompact: boolean
  /** Порог заполнения контекстного окна (0..1) для автосжатия. */
  autoCompactThreshold: number
  /** Override модельной/провайдерской temperature (0..2). null = не передавать
   * параметр, провайдер выберет дефолт сам. */
  temperature: number | null
  /** Формат API: 'openai' (Chat Completions) или 'anthropic' (Messages). Только Custom AI Proxy. */
  apiFormat: ApiFormat
  priceInput: number | null
  priceOutput: number | null
  priceCached: number | null
}

const EMPTY_PROVIDER: ProviderConfig = {
  apiKey: '', baseURL: '', model: '',
  llmProxy: '', llmProxyUser: '', llmProxyPassword: '',
  tlsInsecure: false, caCert: '', apiFormat: 'openai',
  priceInput: null, priceOutput: null, priceCached: null,
  contextWindow: null, compactModel: '',
  autoCompact: true, autoCompactThreshold: 0.85,
  temperature: null,
}

export type Settings = {
  provider: LlmProvider
  /** Per-provider configs — switching provider swaps every LLM setting. */
  providers: Record<LlmProvider, ProviderConfig>
  // Non-LLM (controller / UI) — shared across providers:
  mqttUser: string
  mqttPassword: string
  sshUser: string
  sshPassword: string
  sshKeyPath: string
  discoveryInterval: number
  openBrowser: boolean
}

export const PROVIDER_DEFAULTS: Record<LlmProvider, { baseURL: string; label: string; apiFormat: ApiFormat }> = {
  openai:       { baseURL: 'https://api.openai.com/v1', label: 'OpenAI',          apiFormat: 'openai' },
  aitunnel:     { baseURL: 'https://api.aitunnel.ru/v1', label: 'AITunnel',       apiFormat: 'openai' },
  custom:       { baseURL: '',                          label: 'Custom',          apiFormat: 'openai' },
  custom_proxy: { baseURL: '',                          label: 'Custom AI Proxy', apiFormat: 'openai' },
}

/** Redacted view of a provider's settings (no plaintext secrets). */
export type ProviderConfigPublic = Omit<ProviderConfig, 'apiKey' | 'llmProxyPassword'> & {
  apiKeyConfigured: boolean
  llmProxyPasswordConfigured: boolean
}

export type PublicSettings = {
  provider: LlmProvider
  providers: Record<LlmProvider, ProviderConfigPublic>
  // Flat view of the *current* provider, so existing UI code keeps working:
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
  compactModel: string
  autoCompact: boolean
  autoCompactThreshold: number
  temperature: number | null
  apiKeyConfigured: boolean
  llmProxyPasswordConfigured: boolean
  // Shared (controller/UI):
  mqttUser: string
  sshUser: string
  sshKeyPath: string
  discoveryInterval: number
  openBrowser: boolean
  mqttPasswordConfigured: boolean
  sshPasswordConfigured: boolean
  storagePath: string
}

const DEFAULTS: Settings = {
  provider: 'openai',
  providers: {
    openai:       { ...EMPTY_PROVIDER, apiFormat: 'openai' },
    // AITunnel сам сжимает контекст на своей стороне (message-transforms),
    // поэтому клиентское авто-сжатие по умолчанию выключено. Юзер может
    // включить вручную если хочет явный checkpoint с summary в истории чата.
    aitunnel:     { ...EMPTY_PROVIDER, apiFormat: 'openai', autoCompact: false },
    custom:       { ...EMPTY_PROVIDER, apiFormat: 'openai' },
    custom_proxy: { ...EMPTY_PROVIDER, apiFormat: 'openai' },
  },
  mqttUser: '',
  mqttPassword: '',
  sshUser: 'root',
  sshPassword: 'wirenboard',
  sshKeyPath: '',
  discoveryInterval: 15000,
  openBrowser: true,
}

export class SettingsStore {
  private file: string
  private cache: Settings = { ...DEFAULTS }
  private listeners = new Set<(s: Settings) => void>()

  constructor(file?: string) {
    this.file = file ?? defaultStoragePath()
  }

  /** Load: defaults < env (first-run hints) < settings file (user choices). */
  async load(): Promise<Settings> {
    let onDisk: Record<string, unknown> = {}
    if (existsSync(this.file)) {
      try {
        onDisk = JSON.parse(await readFile(this.file, 'utf8')) as Record<string, unknown>
      } catch {
        onDisk = {}
      }
    }
    const env = envOverrides()
    const fileMissing = !existsSync(this.file)
    this.cache = mergeWithMigration(DEFAULTS, env, onDisk)
    if (fileMissing && Object.keys(env).length) {
      await this.persist()
    }
    return this.cache
  }

  get(): Settings {
    return this.cache
  }

  /** The currently active LLM-side config (keyed by `provider`). */
  current(): ProviderConfig {
    return this.cache.providers[this.cache.provider]
  }

  /** Sanitize for the UI — never echo secrets. */
  toPublic(): PublicSettings {
    const cur = this.current()
    const providersPublic: Record<LlmProvider, ProviderConfigPublic> = {
      openai:       redactProvider(this.cache.providers.openai),
      aitunnel:     redactProvider(this.cache.providers.aitunnel),
      custom:       redactProvider(this.cache.providers.custom),
      custom_proxy: redactProvider(this.cache.providers.custom_proxy),
    }
    return {
      provider: this.cache.provider,
      providers: providersPublic,
      baseURL: cur.baseURL,
      model: cur.model,
      llmProxy: cur.llmProxy,
      llmProxyUser: cur.llmProxyUser,
      tlsInsecure: cur.tlsInsecure,
      caCert: cur.caCert,
      apiFormat: cur.apiFormat,
      priceInput: cur.priceInput,
      priceOutput: cur.priceOutput,
      priceCached: cur.priceCached,
      contextWindow: cur.contextWindow,
      compactModel: cur.compactModel,
      autoCompact: cur.autoCompact,
      autoCompactThreshold: cur.autoCompactThreshold,
      temperature: cur.temperature,
      apiKeyConfigured: !!cur.apiKey,
      llmProxyPasswordConfigured: !!cur.llmProxyPassword,
      mqttUser: this.cache.mqttUser,
      sshUser: this.cache.sshUser,
      sshKeyPath: this.cache.sshKeyPath,
      discoveryInterval: this.cache.discoveryInterval,
      openBrowser: this.cache.openBrowser,
      mqttPasswordConfigured: !!this.cache.mqttPassword,
      sshPasswordConfigured: !!this.cache.sshPassword,
      storagePath: this.file,
    }
  }

  /**
   * Update sub-fields. Provider-scoped flat keys (apiKey, baseURL, model, …)
   * are routed into `providers[targetProvider]` — by default the active one,
   * or the explicit `provider` field when the patch switches providers.
   */
  async update(patch: Record<string, unknown>): Promise<Settings> {
    const targetProvider: LlmProvider =
      typeof patch['provider'] === 'string' && isLlmProvider(patch['provider'])
        ? patch['provider']
        : this.cache.provider
    if (targetProvider !== this.cache.provider) {
      this.cache = { ...this.cache, provider: targetProvider }
    }
    const next: ProviderConfig = { ...this.cache.providers[targetProvider] }
    let providerTouched = false
    for (const k of PROVIDER_FIELDS) {
      if (k in patch) {
        ;(next as any)[k] = patch[k]
        providerTouched = true
      }
    }
    if (providerTouched) {
      this.cache = {
        ...this.cache,
        providers: { ...this.cache.providers, [targetProvider]: next },
      }
    }
    for (const k of SHARED_FIELDS) {
      if (k in patch) (this.cache as any)[k] = patch[k]
    }
    await this.persist()
    for (const fn of this.listeners) fn(this.cache)
    return this.cache
  }

  async clearKey() {
    const p = this.cache.provider
    this.cache.providers[p] = { ...this.cache.providers[p], apiKey: '' }
    await this.persist()
    for (const fn of this.listeners) fn(this.cache)
  }

  onChange(fn: (s: Settings) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  storagePath(): string {
    return this.file
  }

  private async persist() {
    await mkdir(path.dirname(this.file), { recursive: true })
    await writeFile(this.file, JSON.stringify(this.cache, null, 2), { mode: 0o600 })
  }
}

const PROVIDER_FIELDS = [
  'apiKey', 'baseURL', 'model',
  'llmProxy', 'llmProxyUser', 'llmProxyPassword',
  'tlsInsecure', 'caCert', 'apiFormat',
  'priceInput', 'priceOutput', 'priceCached',
  'contextWindow', 'compactModel',
  'autoCompact', 'autoCompactThreshold',
  'temperature',
] as const

const SHARED_FIELDS = [
  'mqttUser', 'mqttPassword',
  'sshUser', 'sshPassword', 'sshKeyPath',
  'discoveryInterval', 'openBrowser',
] as const

function isLlmProvider(v: unknown): v is LlmProvider {
  // Anthropic dropped — старые конфиги мигрируем в OpenAI на загрузке
  if (v === 'anthropic') return false
  return v === 'openai' || v === 'aitunnel' || v === 'custom' || v === 'custom_proxy'
}

function redactProvider(p: ProviderConfig): ProviderConfigPublic {
  return {
    baseURL: p.baseURL,
    model: p.model,
    llmProxy: p.llmProxy,
    llmProxyUser: p.llmProxyUser,
    tlsInsecure: p.tlsInsecure,
    caCert: p.caCert,
    apiFormat: p.apiFormat,
    priceInput: p.priceInput,
    priceOutput: p.priceOutput,
    priceCached: p.priceCached,
    contextWindow: p.contextWindow,
    compactModel: p.compactModel,
    autoCompact: p.autoCompact,
    autoCompactThreshold: p.autoCompactThreshold,
    temperature: p.temperature,
    apiKeyConfigured: !!p.apiKey,
    llmProxyPasswordConfigured: !!p.llmProxyPassword,
  }
}

/**
 * Combine defaults, env overrides and on-disk JSON into a fully-formed
 * Settings, transparently migrating the old flat schema (apiKey, baseURL,
 * model, … at the top level) into the new per-provider `providers[…]` shape.
 */
function mergeWithMigration(defaults: Settings, env: Partial<Settings> & Partial<ProviderConfig>, disk: Record<string, unknown>): Settings {
  const provider: LlmProvider = isLlmProvider(disk['provider']) ? disk['provider']
    : isLlmProvider(env.provider) ? env.provider
    : defaults.provider

  // Start with defaults, then layer on disk shared fields
  const result: Settings = {
    ...defaults,
    provider,
    providers: {
      openai:       { ...defaults.providers.openai },
      aitunnel:     { ...defaults.providers.aitunnel },
      custom:       { ...defaults.providers.custom },
      custom_proxy: { ...defaults.providers.custom_proxy },
    },
  }
  for (const k of SHARED_FIELDS) {
    const v = (disk as any)[k]
    if (v !== undefined) (result as any)[k] = v
    else if ((env as any)[k] !== undefined) (result as any)[k] = (env as any)[k]
  }

  // New schema: providers map — copy directly
  if (disk['providers'] && typeof disk['providers'] === 'object') {
    const providersOnDisk = disk['providers'] as Record<string, Partial<ProviderConfig>>
    for (const p of ['openai', 'aitunnel', 'custom', 'custom_proxy'] as const) {
      if (providersOnDisk[p]) {
        result.providers[p] = { ...EMPTY_PROVIDER, ...providersOnDisk[p] }
      }
    }
  }

  // Legacy schema: flat fields at top level → fold into providers[provider]
  // Each field migrates only if not already supplied via the new schema.
  const legacy: Partial<ProviderConfig> = {}
  for (const k of PROVIDER_FIELDS) {
    if (disk[k] !== undefined) (legacy as any)[k] = disk[k]
    else if ((env as any)[k] !== undefined) (legacy as any)[k] = (env as any)[k]
  }
  if (Object.keys(legacy).length > 0) {
    result.providers[provider] = { ...result.providers[provider], ...legacy }
  }

  return result
}

/** Where to store settings: рядом с бинарём (USB-friendly), фолбэк — XDG/APPDATA. */
function defaultStoragePath(): string {
  // process.execPath для bun-скомпилированного бинарника указывает на сам exe.
  // В dev-режиме (`bun --hot src/server/index.ts`) — на бинарь bun, тогда уходим в XDG/APPDATA,
  // чтобы не засорять рабочую копию проекта.
  // В AppImage (APPIMAGE env set) — бинарник в read-only squashfs, уходим в XDG.
  const exe = process.execPath
  const isCompiled = exe && !path.basename(exe).startsWith('bun')
  if (isCompiled && !process.env['APPIMAGE']) return path.join(path.dirname(exe), 'wb-ai-helper-settings.json')
  const cfg =
    process.platform === 'win32'
      ? path.join(process.env['APPDATA'] ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'wb-ai-helper')
      : path.join(process.env['XDG_CONFIG_HOME'] ?? path.join(os.homedir(), '.config'), 'wb-ai-helper')
  return path.join(cfg, 'settings.json')
}

/**
 * Env-var seeds for first launch. Values are returned in the legacy flat
 * shape; mergeWithMigration takes care of folding LLM-side fields into
 * `providers[currentProvider]`.
 */
function envOverrides(): Partial<Settings> & Partial<ProviderConfig> {
  const out: Partial<Settings> & Partial<ProviderConfig> = {}
  if (process.env['OPENAI_API_KEY']) out.apiKey = process.env['OPENAI_API_KEY']!
  if (process.env['OPENAI_BASE_URL']) out.baseURL = process.env['OPENAI_BASE_URL']!
  if (process.env['OPENAI_MODEL']) out.model = process.env['OPENAI_MODEL']!
  if (process.env['WB_HELPER_MQTT_USER']) out.mqttUser = process.env['WB_HELPER_MQTT_USER']!
  if (process.env['WB_HELPER_MQTT_PASSWORD']) out.mqttPassword = process.env['WB_HELPER_MQTT_PASSWORD']!
  if (process.env['WB_HELPER_SSH_USER']) out.sshUser = process.env['WB_HELPER_SSH_USER']!
  if (process.env['WB_HELPER_SSH_PASSWORD']) out.sshPassword = process.env['WB_HELPER_SSH_PASSWORD']!
  if (process.env['WB_HELPER_SSH_KEY']) out.sshKeyPath = process.env['WB_HELPER_SSH_KEY']!
  if (process.env['WB_HELPER_DISCOVERY_INTERVAL']) {
    out.discoveryInterval = Number(process.env['WB_HELPER_DISCOVERY_INTERVAL'])
  }
  if (process.env['WB_HELPER_OPEN_BROWSER']) out.openBrowser = process.env['WB_HELPER_OPEN_BROWSER'] !== '0'
  return out
}

/** Лёгкий тип записи модели — id обязателен, contextLength опционален.
 * Заполняется когда провайдер отдаёт расширенные поля в `/v1/models`
 * (OpenRouter, LiteLLM, Ollama-compat). У aitunnel/OpenAI этих полей нет. */
export interface ModelInfo {
  id: string
  contextLength?: number
}

/** Достаём context length из произвольного объекта модели в ответе /v1/models.
 * Разные провайдеры называют поле по-разному: пытаемся все распространённые. */
function pickContextLength(m: Record<string, unknown>): number | undefined {
  const candidates = [
    m['context_length'],
    m['context_window'],
    m['max_context_length'],
    m['max_context_tokens'],
    m['max_input_tokens'],
    m['max_tokens'],
    m['n_ctx'],
    // OpenRouter — top_provider.context_length
    (m['top_provider'] as Record<string, unknown> | undefined)?.['context_length'],
    // Ollama-compat — details.context_length
    (m['details'] as Record<string, unknown> | undefined)?.['context_length'],
  ]
  for (const v of candidates) {
    if (typeof v === 'number' && v > 0 && Number.isFinite(v)) return Math.floor(v)
    if (typeof v === 'string') {
      const n = Number(v)
      if (Number.isFinite(n) && n > 0) return Math.floor(n)
    }
  }
  return undefined
}

export async function listModels(
  apiKey: string,
  baseURL?: string,
  opts: { proxy?: string; proxyUser?: string; proxyPassword?: string; tlsInsecure?: boolean; caCert?: string } = {},
): Promise<ModelInfo[]> {
  const root = baseURL?.replace(/\/$/, '') ?? 'https://api.openai.com/v1'
  const url = root + '/models'
  const proxyUrl = opts.proxy ? buildProxyUrl(opts.proxy, opts.proxyUser, opts.proxyPassword) : undefined

  const tls: Record<string, unknown> = {}
  if (opts.tlsInsecure) tls['rejectUnauthorized'] = false
  if (opts.caCert) tls['ca'] = Buffer.from(opts.caCert, 'utf8')

  const init: RequestInit = {
    headers: { authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(15000),
  }
  if (proxyUrl) (init as any).proxy = proxyUrl
  if (Object.keys(tls).length) (init as any).tls = tls

  // VseGPT (and a few other proxies) sometimes drops the first connection;
  // retry once on a transient socket error.
  let lastErr: unknown = null
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, init)
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`)
      }
      const data = (await res.json()) as { data?: Record<string, unknown>[] }
      if (!Array.isArray(data.data)) throw new Error('unexpected /v1/models response')
      const items: ModelInfo[] = data.data
        .filter((m): m is Record<string, unknown> & { id: string } => typeof m['id'] === 'string')
        .map((m) => {
          const ctx = pickContextLength(m)
          return ctx ? { id: m.id, contextLength: ctx } : { id: m.id }
        })
      items.sort((a, b) => {
        const score = (s: string) =>
          /^(gpt|o\d|claude|llama|qwen|deepseek|mistral|mixtral)/i.test(s) ? 0 : 1
        const sa = score(a.id)
        const sb = score(b.id)
        return sa !== sb ? sa - sb : a.id.localeCompare(b.id)
      })
      return items
    } catch (e) {
      lastErr = e
      const msg = e instanceof Error ? e.message : String(e)
      // Only retry transient socket errors, not auth/HTTP errors
      if (!/socket|connection|ECONNRESET|fetch failed/i.test(msg)) break
    }
  }
  // /v1/models didn't work — try the "ask for a missing model" discovery trick.
  // GitHub Copilot's proxy (and similar gateways) return 400 with the full list
  // of available models in the error message when an unknown model is requested.
  try {
    const probed = await probeModelsViaError(root, apiKey, init)
    if (probed.length) return probed.map((id) => ({ id }))
  } catch { /* probing failed too — fall through and surface the original error */ }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

/**
 * Whitelist of models known to work via /v1/chat/completions through the
 * Copilot-style proxies. Reasoning-only models (o1/o3, gpt-5.x main line)
 * need /v1/responses — будут открыты когда допишем поддержку Responses API.
 *
 * Order = relevance: cheap mini first, then mid, then top-tier.
 */
const SUPPORTED_PROXY_MODELS = [
  'gpt-4o-mini',
  'gpt-4.1-mini',
  'claude-haiku-4.5',
  'grok-code-fast-1',
  'gpt-4.1',
  'gpt-4o',
  'claude-sonnet-4.5',
  'claude-sonnet-4.6',
  'claude-opus-4.5',
  'claude-opus-4.7',
]

/**
 * GitHub Copilot premium-request multipliers (приблизительно по публичному
 * документу — поправь если устарело). Показывается рядом с моделью в комбо-боксе:
 *   0× — включено в подписку без лимита
 *   N× — N premium-запросов из месячной квоты на каждое сообщение
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
 * Some OpenAI-compatible gateways (e.g. Copilot via the Claude proxy) don't
 * expose `/v1/models` but DO list every valid model when you POST to
 * `/v1/chat/completions` with a non-existent model name. Parse that out.
 *
 * For now the result is INTERSECTED with our whitelist of chat/completions-
 * compatible models, otherwise the user could pick a reasoning-only model
 * (gpt-5.4-mini, o3-mini, ...) and get an opaque 400.
 */
async function probeModelsViaError(root: string, apiKey: string, baseInit: RequestInit): Promise<string[]> {
  const probeBody = JSON.stringify({
    model: '__probe-' + Math.random().toString(36).slice(2, 8),
    messages: [{ role: 'user', content: 'probe' }],
    max_tokens: 1,
  })
  const init: RequestInit = {
    ...baseInit,
    method: 'POST',
    headers: { ...(baseInit.headers || {}), 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: probeBody,
  }
  const res = await fetch(root + '/chat/completions', init)
  if (res.ok) return []
  const text = await res.text().catch(() => '')
  const m = text.match(/[Aa]vailable\s+models?\s*[:\-]\s*\[?([^\]\n]+)\]?/)
  if (!m) return []
  const proxyOffered = new Set(m[1]!.split(/[\s,]+/).map(s => s.trim()).filter(s => s && !/^[\[\]]$/.test(s)))
  // Intersection in our preferred order
  const safe = SUPPORTED_PROXY_MODELS.filter(name => proxyOffered.has(name))
  return safe.length ? safe : SUPPORTED_PROXY_MODELS  // если прокси не отдал список — используем дефолт
}

function buildProxyUrl(proxy: string, user?: string, password?: string): string {
  if (!user) return proxy
  try {
    const u = new URL(proxy)
    u.username = encodeURIComponent(user)
    if (password) u.password = encodeURIComponent(password)
    return u.toString()
  } catch {
    return proxy
  }
}
