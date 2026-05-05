import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

export type LlmProvider = 'openai' | 'vsegpt' | 'custom'

export type Settings = {
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
  /**
   * Cost per 1 unit, semantics depend on `provider`:
   *  - openai: USD per 1M tokens (input/output/cached)
   *  - vsegpt: RUB per 1000 chars (input/output; cached not used — VseGPT has no cache pricing)
   *  - custom: ignored
   */
  priceInput: number | null
  priceOutput: number | null
  priceCached: number | null
}

export const PROVIDER_DEFAULTS: Record<LlmProvider, { baseURL: string; label: string }> = {
  openai: { baseURL: 'https://api.openai.com/v1', label: 'OpenAI' },
  vsegpt: { baseURL: 'https://api.vsegpt.ru/v1', label: 'VseGPT.Ru' },
  custom: { baseURL: '', label: 'Custom' },
}

export type PublicSettings = Omit<Settings, 'apiKey' | 'mqttPassword' | 'sshPassword' | 'llmProxyPassword'> & {
  apiKeyConfigured: boolean
  mqttPasswordConfigured: boolean
  sshPasswordConfigured: boolean
  llmProxyPasswordConfigured: boolean
  storagePath: string
}

const DEFAULTS: Settings = {
  provider: 'openai',
  apiKey: '',
  baseURL: '',
  model: '',
  llmProxy: '',
  llmProxyUser: '',
  llmProxyPassword: '',
  tlsInsecure: false,
  mqttUser: '',
  mqttPassword: '',
  sshUser: 'root',
  sshPassword: 'wirenboard',
  sshKeyPath: '',
  discoveryInterval: 15000,
  openBrowser: true,
  priceInput: null,
  priceOutput: null,
  priceCached: null,
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
    let onDisk: Partial<Settings> = {}
    if (existsSync(this.file)) {
      try {
        onDisk = JSON.parse(await readFile(this.file, 'utf8')) as Partial<Settings>
      } catch {
        onDisk = {}
      }
    }
    const env = envOverrides()
    // Если файла настроек ещё нет — env-переменные становятся стартовыми значениями
    // и пишутся на диск, чтобы дальше юзер мог редактировать через UI.
    const fileMissing = !existsSync(this.file)
    this.cache = { ...DEFAULTS, ...env, ...onDisk }
    if (fileMissing && Object.keys(env).length) {
      await this.persist()
    }
    return this.cache
  }

  get(): Settings {
    return this.cache
  }

  /** Sanitize for the UI — never echo secrets. */
  toPublic(): PublicSettings {
    return {
      provider: this.cache.provider,
      baseURL: this.cache.baseURL,
      model: this.cache.model,
      llmProxy: this.cache.llmProxy,
      llmProxyUser: this.cache.llmProxyUser,
      tlsInsecure: this.cache.tlsInsecure,
      mqttUser: this.cache.mqttUser,
      sshUser: this.cache.sshUser,
      sshKeyPath: this.cache.sshKeyPath,
      discoveryInterval: this.cache.discoveryInterval,
      openBrowser: this.cache.openBrowser,
      priceInput: this.cache.priceInput,
      priceOutput: this.cache.priceOutput,
      priceCached: this.cache.priceCached,
      apiKeyConfigured: !!this.cache.apiKey,
      mqttPasswordConfigured: !!this.cache.mqttPassword,
      sshPasswordConfigured: !!this.cache.sshPassword,
      llmProxyPasswordConfigured: !!this.cache.llmProxyPassword,
      storagePath: this.file,
    }
  }

  async update(patch: Partial<Settings>): Promise<Settings> {
    this.cache = { ...this.cache, ...patch }
    await this.persist()
    for (const fn of this.listeners) fn(this.cache)
    return this.cache
  }

  async clearKey() {
    this.cache.apiKey = ''
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

function envOverrides(): Partial<Settings> {
  const out: Partial<Settings> = {}
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
