import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

export type LlmProvider = 'openai' | 'vsegpt' | 'custom'

/** All LLM-side settings live here, one set per provider. */
export interface ProviderConfig {
  apiKey: string
  baseURL: string
  model: string
  llmProxy: string
  llmProxyUser: string
  llmProxyPassword: string
  tlsInsecure: boolean
  priceInput: number | null
  priceOutput: number | null
  priceCached: number | null
}

const EMPTY_PROVIDER: ProviderConfig = {
  apiKey: '', baseURL: '', model: '',
  llmProxy: '', llmProxyUser: '', llmProxyPassword: '',
  tlsInsecure: false,
  priceInput: null, priceOutput: null, priceCached: null,
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

export const PROVIDER_DEFAULTS: Record<LlmProvider, { baseURL: string; label: string }> = {
  openai: { baseURL: 'https://api.openai.com/v1', label: 'OpenAI' },
  vsegpt: { baseURL: 'https://api.vsegpt.ru/v1', label: 'VseGPT.Ru' },
  custom: { baseURL: '', label: 'Custom' },
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
  priceInput: number | null
  priceOutput: number | null
  priceCached: number | null
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
    openai: { ...EMPTY_PROVIDER },
    vsegpt: { ...EMPTY_PROVIDER },
    custom: { ...EMPTY_PROVIDER },
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
      openai: redactProvider(this.cache.providers.openai),
      vsegpt: redactProvider(this.cache.providers.vsegpt),
      custom: redactProvider(this.cache.providers.custom),
    }
    return {
      provider: this.cache.provider,
      providers: providersPublic,
      baseURL: cur.baseURL,
      model: cur.model,
      llmProxy: cur.llmProxy,
      llmProxyUser: cur.llmProxyUser,
      tlsInsecure: cur.tlsInsecure,
      priceInput: cur.priceInput,
      priceOutput: cur.priceOutput,
      priceCached: cur.priceCached,
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
  'tlsInsecure', 'priceInput', 'priceOutput', 'priceCached',
] as const

const SHARED_FIELDS = [
  'mqttUser', 'mqttPassword',
  'sshUser', 'sshPassword', 'sshKeyPath',
  'discoveryInterval', 'openBrowser',
] as const

function isLlmProvider(v: unknown): v is LlmProvider {
  return v === 'openai' || v === 'vsegpt' || v === 'custom'
}

function redactProvider(p: ProviderConfig): ProviderConfigPublic {
  return {
    baseURL: p.baseURL,
    model: p.model,
    llmProxy: p.llmProxy,
    llmProxyUser: p.llmProxyUser,
    tlsInsecure: p.tlsInsecure,
    priceInput: p.priceInput,
    priceOutput: p.priceOutput,
    priceCached: p.priceCached,
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
      openai: { ...defaults.providers.openai },
      vsegpt: { ...defaults.providers.vsegpt },
      custom: { ...defaults.providers.custom },
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
    for (const p of ['openai', 'vsegpt', 'custom'] as const) {
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

export async function listModels(apiKey: string, baseURL?: string): Promise<string[]> {
  const url = (baseURL?.replace(/\/$/, '') ?? 'https://api.openai.com/v1') + '/models'
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(8000),
  })
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`)
  }
  const data = (await res.json()) as { data?: { id: string }[] }
  if (!Array.isArray(data.data)) throw new Error('unexpected /v1/models response')
  // Sort: Чат-модели (gpt/o*/claude/llama/qwen) сначала.
  const ids = data.data.map((m) => m.id)
  return ids.sort((a, b) => {
    const score = (s: string) =>
      /^(gpt|o\d|claude|llama|qwen|deepseek|mistral|mixtral)/i.test(s) ? 0 : 1
    const sa = score(a)
    const sb = score(b)
    return sa !== sb ? sa - sb : a.localeCompare(b)
  })
}
