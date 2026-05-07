<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { api, COPILOT_MULTIPLIERS, PROVIDER_INFO, type AitunnelInfo, type ApiFormat, type LlmProvider, type OpenRouterInfo, type Settings } from '../api'
import ComboboxSearch from './ComboboxSearch.vue'

const props = defineProps<{ settings: Settings | null; open: boolean; version?: string; fontSize?: number }>()
const emit = defineEmits<{
  close: []
  /** Юзер нажал «Сохранить» — родитель может закрыть окно. */
  saved: [Settings]
  /** Авто-сохранение (ключ / провайдер) — родитель только обновляет
   * локальный state, окно НЕ закрывает (юзер ещё в процессе настройки). */
  autoSaved: [Settings]
  fontSizeChange: [number]
}>()

const provider = ref<LlmProvider>('openai')
const apiKey = ref('')
const baseURL = ref('')
const model = ref('')
const compactModel = ref('')
const llmProxy = ref('')
const llmProxyUser = ref('')
const llmProxyPassword = ref('')
const tlsInsecure = ref(false)
const caCert = ref('')
const apiFormat = ref<ApiFormat>('openai')
const priceInput = ref<number | null>(null)
const priceOutput = ref<number | null>(null)
const priceCached = ref<number | null>(null)
const contextWindow = ref<number | null>(null)
const autoCompact = ref(true)
const autoCompactThreshold = ref(0.85)
const temperature = ref<number | null>(null)
const minRequestIntervalMs = ref<number | null>(null)
/** id → context length, заполняется после fetchModels(); используется как
 * подсказка/auto-fill для contextWindow. */
const contextLengths = ref<Record<string, number>>({})

const providerInfo = computed(() => PROVIDER_INFO[provider.value])
const showPriceFields = computed(() => providerInfo.value.pricesEditable)
const baseURLPlaceholder = computed(() => providerInfo.value.defaultBaseURL || 'https://your-endpoint/v1')
const apiKeyConfiguredForProvider = computed(
  () => !!props.settings?.providers?.[provider.value]?.apiKeyConfigured,
)
const llmProxyPasswordConfiguredForProvider = computed(
  () => !!props.settings?.providers?.[provider.value]?.llmProxyPasswordConfigured,
)

/** Load the saved fields for `next` into the form. */
function loadProviderFields(next: LlmProvider) {
  const cfg = props.settings?.providers?.[next]
  const info = PROVIDER_INFO[next]
  apiKey.value = ''
  llmProxyPassword.value = ''
  if (cfg) {
    baseURL.value = cfg.baseURL
    model.value = cfg.model
    compactModel.value = cfg.compactModel ?? ''
    llmProxy.value = cfg.llmProxy
    llmProxyUser.value = cfg.llmProxyUser
    tlsInsecure.value = cfg.tlsInsecure
    caCert.value = cfg.caCert
    apiFormat.value = cfg.apiFormat ?? info.apiFormat
    priceInput.value = cfg.priceInput
    priceOutput.value = cfg.priceOutput
    priceCached.value = cfg.priceCached
    contextWindow.value = cfg.contextWindow
    autoCompact.value = cfg.autoCompact ?? true
    autoCompactThreshold.value = cfg.autoCompactThreshold ?? 0.85
    temperature.value = cfg.temperature
    minRequestIntervalMs.value = cfg.minRequestIntervalMs ?? null
  } else {
    baseURL.value = info.defaultBaseURL
    model.value = ''
    compactModel.value = ''
    llmProxy.value = ''
    llmProxyUser.value = ''
    tlsInsecure.value = false
    caCert.value = ''
    apiFormat.value = info.apiFormat
    priceInput.value = null
    priceOutput.value = null
    priceCached.value = null
    contextWindow.value = null
    autoCompact.value = true
    autoCompactThreshold.value = 0.85
    temperature.value = null
    minRequestIntervalMs.value = null
  }
  // If the loaded baseURL is empty (user never customised), suggest provider's default
  if (!baseURL.value) baseURL.value = info.defaultBaseURL
}

async function onProviderChange(next: LlmProvider) {
  provider.value = next
  loadProviderFields(next)
  models.value = []
  contextLengths.value = {}
  modelsError.value = null
  aitunnelInfo.value = null
  aitunnelInfoError.value = null
  openrouterInfo.value = null
  openrouterInfoError.value = null
  // Сохраняем выбор провайдера на бэке немедленно — иначе info-эндпоинты
  // (`/api/aitunnel/info`, `/api/openrouter/info`) возвращают 400 «провайдер
  // не <name>». Это согласуется с auto-save API-ключа. Эмитим autoSaved,
  // чтобы родитель не закрывал окно настроек посреди работы юзера.
  try {
    const saved = await api.saveSettings({ provider: next })
    emit('autoSaved', saved)
  } catch (e: any) {
    saveError.value = `Не удалось переключить провайдера: ${e?.message ?? String(e)}`
    return
  }
  void refreshAitunnelInfo()
  void refreshOpenrouterInfo()
}
const mqttUser = ref('')
const mqttPassword = ref('')
const sshUser = ref('root')
const sshPassword = ref('')
const sshKeyPath = ref('')
const discoveryInterval = ref(15000)
const openBrowser = ref(true)

const models = ref<string[]>([])
const modelsError = ref<string | null>(null)
const loadingModels = ref(false)
const saving = ref(false)
const saveError = ref<string | null>(null)

// AITunnel-specific: баланс / статистика / email — выводим в шапку настроек
// провайдера, чтобы юзер сразу видел сколько у него на счету.
const aitunnelInfo = ref<AitunnelInfo | null>(null)
const aitunnelInfoError = ref<string | null>(null)
const loadingAitunnelInfo = ref(false)

/** Сколько дней хватит баланса при текущем среднем расходе. Возвращает null
 * если расход 0 (нет истории) или баланс отсутствует. */
const aitunnelDaysLeft = computed<number | null>(() => {
  const info = aitunnelInfo.value
  if (!info?.balance || !info.stats) return null
  const avg = info.stats.avg_daily_spend
  if (!avg || avg <= 0) return null
  return Math.floor(info.balance.balance / avg)
})
const aitunnelLowBalance = computed(() => aitunnelDaysLeft.value !== null && aitunnelDaysLeft.value < 3)

async function refreshAitunnelInfo() {
  if (provider.value !== 'aitunnel') return
  if (!apiKeyConfiguredForProvider.value) return
  loadingAitunnelInfo.value = true
  aitunnelInfoError.value = null
  try {
    aitunnelInfo.value = await api.aitunnelInfo()
  } catch (e: any) {
    aitunnelInfoError.value = e?.message ?? String(e)
  } finally {
    loadingAitunnelInfo.value = false
  }
}

// OpenRouter-specific: credits + лимиты ключа
const openrouterInfo = ref<OpenRouterInfo | null>(null)
const openrouterInfoError = ref<string | null>(null)
const loadingOpenrouterInfo = ref(false)

async function refreshOpenrouterInfo() {
  if (provider.value !== 'openrouter') return
  if (!apiKeyConfiguredForProvider.value) return
  loadingOpenrouterInfo.value = true
  openrouterInfoError.value = null
  try {
    openrouterInfo.value = await api.openrouterInfo()
  } catch (e: any) {
    openrouterInfoError.value = e?.message ?? String(e)
  } finally {
    loadingOpenrouterInfo.value = false
  }
}

const openrouterRemaining = computed<number | null>(() => {
  const info = openrouterInfo.value
  if (!info?.credits) return null
  return info.credits.total_credits - info.credits.total_usage
})
const openrouterLowBalance = computed(() => {
  const r = openrouterRemaining.value
  return r !== null && r < 1
})

/** Контекстное окно текущей модели по данным от провайдера (если он
 * вернул их в /v1/models). Пусто = автоопределение недоступно. */
const detectedContextWindow = computed<number | null>(() => {
  const m = model.value
  if (!m) return null
  return contextLengths.value[m] ?? null
})

const contextWindowPlaceholder = computed(() => {
  if (detectedContextWindow.value) return `авто: ${detectedContextWindow.value.toLocaleString('ru-RU')}`
  return 'напр. 128000 (пусто = по умолчанию 128k)'
})

function applyDetectedContextWindow() {
  if (detectedContextWindow.value) contextWindow.value = detectedContextWindow.value
}

/** Провайдер умеет сжимать контекст на своей стороне — тогда чекбокс
 * `autoCompact` работает как переключатель: off = серверное сжатие,
 * on = клиентский checkpoint (серверное в этом случае отключаем
 * на стороне backend, чтобы не было двойной обработки).
 * AITunnel: server-side всегда, флаг работает как «доп. checkpoint».
 * OpenRouter: middle-out управляется backend'ом из !autoCompact. */
const providerHasServerCompaction = computed(() =>
  provider.value === 'aitunnel' || provider.value === 'openrouter',
)

// Если провайдер не сжимает сам — клиентское авто-сжатие принудительно ВКЛ
// (без него длинный чат просто упадёт при переполнении окна).
watch(providerHasServerCompaction, (has) => {
  if (!has && !autoCompact.value) autoCompact.value = true
}, { immediate: true })

const canFetchModels = computed(() => {
  // For Custom AI Proxy auth often comes from the proxy itself (CA cert + URL-embedded
  // creds), not from a Bearer token. Allow fetching with cert-only.
  const hasAuth = !!apiKey.value || apiKeyConfiguredForProvider.value || (provider.value === 'custom_proxy' && !!caCert.value)
  if (!hasAuth) return false
  if (providerInfo.value.baseURLEditable && !baseURL.value.trim()) return false
  return true
})

async function loadCaCertFromFile(file: File) {
  try {
    const text = await file.text()
    if (!/-----BEGIN CERTIFICATE-----/.test(text)) {
      saveError.value = 'Файл не похож на PEM-сертификат (нет -----BEGIN CERTIFICATE-----)'
      return
    }
    caCert.value = text
    saveError.value = null
  } catch (e: any) {
    saveError.value = `Не удалось прочитать файл: ${e?.message ?? e}`
  }
}

async function exportSettings() {
  try {
    const r = await fetch('/api/settings/export')
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const blob = await r.blob()
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    a.download = `wb-ai-helper-settings-${ts}.json`
    document.body.appendChild(a); a.click(); a.remove()
    setTimeout(() => URL.revokeObjectURL(a.href), 0)
  } catch (e: any) {
    saveError.value = `Экспорт не удался: ${e?.message ?? e}`
  }
}

async function importSettings(file: File) {
  try {
    const text = await file.text()
    const json = JSON.parse(text)
    const r = await fetch('/api/settings/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(json),
    })
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text().catch(() => '')}`)
    const next = await r.json() as Settings
    // autoSaved — окно не закрываем, юзер только что импортировал
    // и может ещё подправить.
    emit('autoSaved', next)
    // Re-load the form from imported state
    provider.value = next.provider
    loadProviderFields(provider.value)
  } catch (e: any) {
    saveError.value = `Импорт не удался: ${e?.message ?? e}`
  }
}

watch(
  () => props.open,
  (v) => {
    if (!v) return
    if (props.settings) {
      provider.value = props.settings.provider
      loadProviderFields(provider.value)
      mqttUser.value = props.settings.mqttUser
      mqttPassword.value = ''
      sshUser.value = props.settings.sshUser || 'root'
      sshPassword.value = ''
      sshKeyPath.value = props.settings.sshKeyPath
      discoveryInterval.value = props.settings.discoveryInterval
      openBrowser.value = props.settings.openBrowser
      if (apiKeyConfiguredForProvider.value) {
        void fetchModels()
        void refreshAitunnelInfo()
        void refreshOpenrouterInfo()
      }
    }
  },
  { immediate: true },
)

async function fetchModels() {
  loadingModels.value = true
  modelsError.value = null
  try {
    // Если юзер успел вставить ключ и сразу нажать кнопку до debounce —
    // дописываем его в этот же запрос, чтобы запрос моделей точно увидел свежий ключ.
    if (apiKey.value) {
      const patch: any = { provider: provider.value, apiKey: apiKey.value }
      if (providerInfo.value.baseURLEditable) patch.baseURL = baseURL.value
      const next = await api.saveSettings(patch)
      apiKey.value = ''
      emit('saved', next)
    }
    const r = await api.models()
    models.value = r.models
    contextLengths.value = r.contextLengths ?? {}
    if (model.value && !r.models.includes(model.value)) {
      // keep custom value as-is
    } else if (!model.value && r.models.length) {
      model.value = r.models[0] ?? ''
    }
  } catch (e: any) {
    modelsError.value = e?.message ?? String(e)
  } finally {
    loadingModels.value = false
  }
}

/**
 * Авто-сохранение API-ключа после ввода (debounce 600ms). Очищаем поле и
 * показываем «(сохранён)» сразу — иначе юзер видит как поле опустошается
 * после нажатия «обновить список» и думает что ключ потерян.
 *
 * Опустошение поля игнорируем — для удаления есть отдельная кнопка.
 */
let apiKeySaveTimer: ReturnType<typeof setTimeout> | null = null
watch(apiKey, (v) => {
  if (apiKeySaveTimer) {
    clearTimeout(apiKeySaveTimer)
    apiKeySaveTimer = null
  }
  if (!v) return
  apiKeySaveTimer = setTimeout(() => {
    apiKeySaveTimer = null
    void autoSaveApiKey()
  }, 600)
})

async function autoSaveApiKey() {
  if (!apiKey.value) return
  saveError.value = null
  try {
    const patch: any = { provider: provider.value, apiKey: apiKey.value }
    if (providerInfo.value.baseURLEditable) patch.baseURL = baseURL.value
    const next = await api.saveSettings(patch)
    apiKey.value = ''
    emit('autoSaved', next)
    // С новым ключом сразу подтягиваем модели и провайдерскую info
    void fetchModels()
    void refreshAitunnelInfo()
    void refreshOpenrouterInfo()
  } catch (e: any) {
    saveError.value = `Не удалось сохранить ключ: ${e?.message ?? String(e)}`
  }
}

async function save() {
  saving.value = true
  saveError.value = null
  try {
    // Only providers with editable baseURL send it; OpenAI uses its default.
    const baseURLForSave = providerInfo.value.baseURLEditable ? baseURL.value : ''
    // For Custom AI Proxy: proxy creds belong inside the URL, force the
    // separate fields empty so they don't override URL-embedded basic auth.
    const proxyUserForSave = provider.value === 'custom_proxy' ? '' : llmProxyUser.value
    const patch: any = {
      provider: provider.value,
      baseURL: baseURLForSave,
      model: model.value,
      compactModel: compactModel.value,
      llmProxy: llmProxy.value,
      llmProxyUser: proxyUserForSave,
      tlsInsecure: tlsInsecure.value,
      caCert: caCert.value,
      apiFormat: apiFormat.value,
      mqttUser: mqttUser.value,
      sshUser: sshUser.value,
      sshKeyPath: sshKeyPath.value,
      discoveryInterval: Number(discoveryInterval.value) || 15000,
      openBrowser: openBrowser.value,
      autoCompact: autoCompact.value,
      autoCompactThreshold: Number(autoCompactThreshold.value) || 0.85,
      priceInput: priceInput.value != null ? Number(priceInput.value) : null,
      priceOutput: priceOutput.value != null ? Number(priceOutput.value) : null,
      priceCached: priceCached.value != null ? Number(priceCached.value) : null,
      contextWindow: contextWindow.value != null && contextWindow.value > 0 ? Number(contextWindow.value) : null,
      temperature: temperature.value != null && Number.isFinite(Number(temperature.value)) ? Number(temperature.value) : null,
      minRequestIntervalMs: minRequestIntervalMs.value != null && Number(minRequestIntervalMs.value) > 0 ? Number(minRequestIntervalMs.value) : null,
    }
    if (apiKey.value) patch.apiKey = apiKey.value
    if (provider.value === 'custom_proxy') {
      // Same reason — wipe any previously stored proxy password
      patch.llmProxyPassword = ''
    } else if (llmProxyPassword.value) {
      patch.llmProxyPassword = llmProxyPassword.value
    }
    if (mqttPassword.value) patch.mqttPassword = mqttPassword.value
    if (sshPassword.value) patch.sshPassword = sshPassword.value
    const next = await api.saveSettings(patch)
    apiKey.value = ''
    mqttPassword.value = ''
    sshPassword.value = ''
    emit('saved', next)
  } catch (e: any) {
    saveError.value = e?.message ?? String(e)
  } finally {
    saving.value = false
  }
}

async function removeKey() {
  if (!confirm('Удалить сохранённый API-ключ?')) return
  try {
    const next = await api.clearApiKey()
    models.value = []
    emit('autoSaved', next)
  } catch (e: any) {
    saveError.value = e?.message ?? String(e)
  }
}
</script>

<template>
  <div v-if="open" class="modal-backdrop" @click.self="emit('close')">
    <div class="modal">
      <div class="modal-header">
        <h2>Настройки</h2>
        <button class="ghost" @click="emit('close')">×</button>
      </div>
      <div class="modal-body">
        <section>
          <h3>LLM</h3>
          <label class="field">
            <span>Провайдер</span>
            <div class="provider-row">
              <label
                v-for="(info, key) in PROVIDER_INFO"
                :key="key"
                class="provider-opt"
                :class="{ active: provider === key }"
                :title="key === 'aitunnel'
                  ? 'Доступен из России без VPN, оплата в рублях'
                  : key === 'openrouter'
                  ? 'Оплата картой или Alipay (можно пополнить из Сбербанка или ТБанка)'
                  : undefined"
              >
                <input type="radio" :value="key" :checked="provider === key" @change="onProviderChange(key as LlmProvider)" />
                <span>{{ info.label }}</span>
              </label>
            </div>
          </label>
          <div v-if="provider === 'aitunnel'" class="muted small provider-hint">
            Доступен из России без VPN, оплата в рублях
          </div>
          <div v-else-if="provider === 'openrouter'" class="muted small provider-hint">
            Оплата картой или Alipay (можно пополнить из Сбербанка или ТБанка)
          </div>
          <div v-if="provider === 'aitunnel' && apiKeyConfiguredForProvider" class="aitunnel-info" :class="{ 'aitunnel-low': aitunnelLowBalance }">
            <div v-if="loadingAitunnelInfo" class="muted small">загрузка баланса…</div>
            <div v-else-if="aitunnelInfoError" class="error small">Не удалось получить данные: {{ aitunnelInfoError }}</div>
            <template v-else-if="aitunnelInfo">
              <div class="aitunnel-row">
                <span class="aitunnel-label">Баланс:</span>
                <strong :class="{ 'aitunnel-low-text': aitunnelLowBalance }">
                  {{ aitunnelInfo.balance ? aitunnelInfo.balance.balance.toLocaleString('ru-RU', { maximumFractionDigits: 2 }) : '—' }} ₽
                </strong>
                <span v-if="aitunnelDaysLeft !== null" class="muted small">
                  ≈ хватит на {{ aitunnelDaysLeft }} {{ aitunnelDaysLeft === 1 ? 'день' : (aitunnelDaysLeft >= 2 && aitunnelDaysLeft <= 4 ? 'дня' : 'дней') }}
                </span>
                <span v-if="aitunnelInfo.balance && aitunnelInfo.balance.budget !== aitunnelInfo.balance.balance" class="muted small">
                  · бюджет ключа {{ aitunnelInfo.balance.budget.toLocaleString('ru-RU', { maximumFractionDigits: 2 }) }} ₽
                </span>
                <span style="flex:1"></span>
                <button type="button" class="ghost small" @click="refreshAitunnelInfo" title="Обновить">↻</button>
              </div>
              <div v-if="aitunnelInfo.stats" class="aitunnel-stats muted small">
                <span>Сегодня: {{ aitunnelInfo.stats.today_spend.toFixed(2) }} ₽ ({{ aitunnelInfo.stats.today_requests }} запр.)</span>
                <span>·</span>
                <span>За месяц: {{ aitunnelInfo.stats.month_spend.toFixed(2) }} ₽ ({{ aitunnelInfo.stats.month_requests }} запр.)</span>
                <span v-if="aitunnelInfo.stats.avg_daily_spend > 0">·</span>
                <span v-if="aitunnelInfo.stats.avg_daily_spend > 0">
                  В среднем {{ aitunnelInfo.stats.avg_daily_spend.toFixed(2) }} ₽/день
                </span>
                <span v-if="aitunnelInfo.stats.top_model_by_spend">·</span>
                <span v-if="aitunnelInfo.stats.top_model_by_spend">
                  Топ: <code>{{ aitunnelInfo.stats.top_model_by_spend }}</code>
                </span>
              </div>
              <div v-if="aitunnelInfo.me?.email" class="muted small">{{ aitunnelInfo.me.email }}</div>
            </template>
          </div>

          <div v-if="provider === 'openrouter' && apiKeyConfiguredForProvider" class="aitunnel-info" :class="{ 'aitunnel-low': openrouterLowBalance }">
            <div v-if="loadingOpenrouterInfo" class="muted small">загрузка баланса…</div>
            <div v-else-if="openrouterInfoError" class="error small">Не удалось получить данные: {{ openrouterInfoError }}</div>
            <template v-else-if="openrouterInfo">
              <div class="aitunnel-row">
                <span class="aitunnel-label">Остаток:</span>
                <strong :class="{ 'aitunnel-low-text': openrouterLowBalance }">
                  ${{ openrouterRemaining !== null ? openrouterRemaining.toLocaleString('en-US', { maximumFractionDigits: 4 }) : '—' }}
                </strong>
                <span v-if="openrouterInfo.credits" class="muted small">
                  · потрачено ${{ openrouterInfo.credits.total_usage.toLocaleString('en-US', { maximumFractionDigits: 4 }) }}
                  / куплено ${{ openrouterInfo.credits.total_credits.toLocaleString('en-US', { maximumFractionDigits: 2 }) }}
                </span>
                <span style="flex:1"></span>
                <button type="button" class="ghost small" @click="refreshOpenrouterInfo" title="Обновить">↻</button>
              </div>
              <div v-if="openrouterInfo.key" class="aitunnel-stats muted small">
                <span v-if="openrouterInfo.key.label">Ключ: <code>{{ openrouterInfo.key.label }}</code></span>
                <span v-if="openrouterInfo.key.is_free_tier">·</span>
                <span v-if="openrouterInfo.key.is_free_tier">free-tier</span>
                <span v-if="openrouterInfo.key.limit != null">·</span>
                <span v-if="openrouterInfo.key.limit != null">
                  лимит ${{ openrouterInfo.key.limit }}<template v-if="openrouterInfo.key.limit_remaining != null">,
                  осталось ${{ openrouterInfo.key.limit_remaining.toLocaleString('en-US', { maximumFractionDigits: 4 }) }}</template>
                </span>
                <span v-if="openrouterInfo.key.rate_limit">·</span>
                <span v-if="openrouterInfo.key.rate_limit">
                  rate {{ openrouterInfo.key.rate_limit.requests }}/{{ openrouterInfo.key.rate_limit.interval }}
                </span>
              </div>
            </template>
          </div>

          <label class="field">
            <span>
              API-ключ {{ apiKeyConfiguredForProvider ? '(сохранён)' : '(не задан)' }}
              <a
                v-if="providerInfo.signupUrl"
                :href="providerInfo.signupUrl"
                target="_blank"
                rel="noopener noreferrer"
                class="key-link"
              >Получить ключ ↗</a>
            </span>
            <div class="row">
              <input
                type="password"
                v-model="apiKey"
                :placeholder="apiKeyConfiguredForProvider ? '••• оставьте пустым чтобы не менять' : 'sk-...'"
                autocomplete="off"
              />
              <button
                v-if="apiKeyConfiguredForProvider"
                class="ghost danger"
                @click="removeKey"
              >удалить</button>
            </div>
          </label>

          <label v-if="providerInfo.supportsCaCert" class="field">
            <span>CA-сертификат прокси (PEM)</span>
            <div v-if="caCert" class="ca-loaded">
              <span>✓ сертификат загружен ({{ Math.round(caCert.length / 1024 * 10) / 10 }} КБ)</span>
              <button type="button" class="ghost danger" @click="caCert = ''">удалить</button>
            </div>
            <div v-else class="row" style="gap:6px">
              <input ref="caFileInput" type="file" accept=".pem,.crt,.cer,.txt" hidden @change="(e: Event) => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) loadCaCertFromFile(f); (e.target as HTMLInputElement).value = '' }" />
              <button type="button" class="small" @click="($refs.caFileInput as HTMLInputElement).click()">📁 Загрузить .pem</button>
              <span class="muted small">для MITM-прокси типа Claude proxy</span>
            </div>
          </label>

          <label v-if="providerInfo.baseURLEditable" class="field">
            <span>Base URL</span>
            <input v-model="baseURL" :placeholder="baseURLPlaceholder" />
          </label>

          <label class="field">
            <span>Прокси для LLM <span class="muted small">(необязательно)</span></span>
            <input v-model="llmProxy" placeholder="http://proxy-host:8080" />
          </label>
          <div v-if="llmProxy && provider !== 'custom_proxy'" class="proxy-auth-row">
            <label class="field" style="flex:1;margin-bottom:0">
              <span>Логин прокси <span class="muted small">(опционально)</span></span>
              <input v-model="llmProxyUser" placeholder="user" autocomplete="off" />
            </label>
            <label class="field" style="flex:1;margin-bottom:0">
              <span>Пароль прокси {{ llmProxyPasswordConfiguredForProvider ? '(сохранён)' : '' }}</span>
              <input
                type="password"
                v-model="llmProxyPassword"
                :placeholder="llmProxyPasswordConfiguredForProvider ? '••• оставьте пустым чтобы не менять' : ''"
                autocomplete="off"
              />
            </label>
          </div>
          <p v-else-if="provider === 'custom_proxy' && llmProxy" class="muted small" style="margin: -4px 0 8px;">
            Логин/пароль прокси держи прямо в URL: <code>https://USER:PASS@host:port</code>
          </p>

          <label class="field checkbox-field">
            <input type="checkbox" v-model="tlsInsecure" />
            <span>Отключить проверку TLS-сертификата <span class="muted small">(для self-signed)</span></span>
          </label>

          <label class="field">
            <div class="spread">
              <span>Модель</span>
              <button
                class="small"
                :disabled="!canFetchModels || loadingModels"
                @click="fetchModels"
              >{{ loadingModels ? 'загрузка…' : 'обновить список' }}</button>
            </div>
            <div v-if="!apiKeyConfiguredForProvider && !apiKey" class="muted small" style="margin-top:4px">
              Введите API-ключ, чтобы загрузить список моделей.
            </div>
            <div v-else-if="providerInfo.baseURLEditable && !baseURL.trim()" class="muted small" style="margin-top:4px">
              Укажите Base URL.
            </div>
            <ComboboxSearch
              v-else-if="models.length"
              :modelValue="model"
              :options="models"
              :badges="provider === 'custom_proxy' ? COPILOT_MULTIPLIERS : undefined"
              placeholder="начните печатать для поиска…"
              @update:modelValue="model = $event"
            />
            <input
              v-else
              v-model="model"
              placeholder="нажмите «обновить список» или впишите имя модели"
              style="margin-top:4px"
            />
            <div v-if="modelsError" class="error small">{{ modelsError }}</div>
          </label>

          <label class="field">
            <span>Temperature <span class="muted small">(пусто = дефолт провайдера)</span></span>
            <input
              type="number"
              min="0"
              max="2"
              step="0.1"
              v-model.number="temperature"
              placeholder="напр. 0.7 — оставь пустым чтобы использовать дефолт"
            />
          </label>

          <label class="field">
            <span>Минимальный интервал между запросами, мс <span class="muted small">(пусто = без троттлинга)</span></span>
            <input
              type="number"
              min="0"
              step="100"
              v-model.number="minRequestIntervalMs"
              placeholder="напр. 1000 — не чаще одного запроса в секунду"
            />
            <div class="muted small" style="margin-top:4px">
              Помогает избежать бана у строгих провайдеров. На 429 (rate-limit) клиент автоматически ждёт и пробует снова — это видно в чате как «Провайдер занят, ждём…».
            </div>
          </label>

          <template v-if="showPriceFields">
            <div class="subsection-label">Стоимость</div>
            <label class="field">
              <span>Цена входных токенов ($/1M)</span>
              <input type="number" min="0" step="0.01" v-model.number="priceInput" placeholder="напр. 0.15" />
            </label>
            <label class="field">
              <span>Цена выходных токенов ($/1M)</span>
              <input type="number" min="0" step="0.01" v-model.number="priceOutput" placeholder="напр. 0.60" />
            </label>
            <label class="field">
              <span>Цена кэшированных токенов ($/1M) <span class="muted small">(по умолчанию — как входные)</span></span>
              <input type="number" min="0" step="0.01" v-model.number="priceCached" placeholder="напр. 0.075" />
            </label>
          </template>

          <div class="subsection-label">Контекст</div>

          <div v-if="provider === 'aitunnel'" class="muted small" style="margin-bottom:6px; padding:6px 8px; border-left:2px solid var(--accent); background: color-mix(in srgb, var(--accent) 4%, var(--bg))">
            AITunnel сжимает контекст автоматически на своей стороне
            (<a href="https://docs.aitunnel.ru/features/message-transforms.html" target="_blank" rel="noopener noreferrer">message-transforms</a>).
            Включи клиентское сжатие ниже, если хочешь явный <code>checkpoint</code> с summary в твоей истории чата.
          </div>
          <div v-else-if="provider === 'openrouter'" class="muted small" style="margin-bottom:6px; padding:6px 8px; border-left:2px solid var(--accent); background: color-mix(in srgb, var(--accent) 4%, var(--bg))">
            OpenRouter сжимает контекст автоматически на своей стороне
            (<a href="https://openrouter.ai/docs/features/message-transforms" target="_blank" rel="noopener noreferrer">middle-out</a>).
            Включи клиентское сжатие ниже, если хочешь явный <code>checkpoint</code> с summary в твоей истории чата.
          </div>

          <label v-if="providerHasServerCompaction" class="field checkbox-field">
            <input type="checkbox" v-model="autoCompact" />
            <span>Клиентское авто-сжатие контекста (через инструмент checkpoint)</span>
          </label>

          <template v-if="autoCompact">
            <label class="field">
              <div class="spread">
                <span>Размер контекстного окна (токенов)</span>
                <button
                  v-if="detectedContextWindow && contextWindow !== detectedContextWindow"
                  type="button"
                  class="small"
                  @click="applyDetectedContextWindow"
                  :title="`Подставить значение, полученное от провайдера: ${detectedContextWindow.toLocaleString('ru-RU')}`"
                >подставить авто</button>
              </div>
              <input
                type="number"
                min="1024"
                step="1024"
                v-model.number="contextWindow"
                :placeholder="contextWindowPlaceholder"
              />
              <div class="muted small" style="margin-top:4px">
                Пусто — берётся либо значение от провайдера ({{ detectedContextWindow ? detectedContextWindow.toLocaleString('ru-RU') : 'нет' }}),
                либо встроенная таблица известных моделей, либо 128 000 по умолчанию.
              </div>
            </label>

            <label class="field">
              <span>Модель для сжатия контекста <span class="muted small">(опционально, обычно дешевле основной)</span></span>
              <ComboboxSearch
                v-if="models.length"
                :modelValue="compactModel"
                :options="['', ...models]"
                :badges="provider === 'custom_proxy' ? COPILOT_MULTIPLIERS : undefined"
                placeholder="(использовать основную модель)"
                @update:modelValue="compactModel = $event"
              />
              <input
                v-else
                v-model="compactModel"
                placeholder="(использовать основную модель)"
              />
            </label>

            <label class="field" style="margin-top:-4px">
              <div class="spread">
                <span>Порог автосжатия</span>
                <span class="muted small">{{ Math.round(autoCompactThreshold * 100) }}%</span>
              </div>
              <input
                type="range" min="0.5" max="0.95" step="0.05"
                v-model.number="autoCompactThreshold"
                style="width:100%; padding:0; background:transparent; border:none;"
              />
              <div class="muted small">
                Когда заполнение превысит этот порог — будет автоматически отправлен запрос на checkpoint
                (используется
                <code v-if="compactModel">{{ compactModel }}</code>
                <span v-else>основная модель</span>).
                Сколько останется после сжатия — зависит от размера последнего раунда tool calls (обычно 5–20% от окна).
              </div>
            </label>
          </template>
        </section>

        <section>
          <h3>MQTT (на контроллерах)</h3>
          <label class="field">
            <span>Пользователь</span>
            <input v-model="mqttUser" placeholder="по умолчанию пусто (анонимно)" />
          </label>
          <label class="field">
            <span>Пароль {{ settings?.mqttPasswordConfigured ? '(сохранён)' : '' }}</span>
            <input
              type="password"
              v-model="mqttPassword"
              :placeholder="settings?.mqttPasswordConfigured ? '••• оставьте пустым чтобы не менять' : ''"
            />
          </label>
        </section>

        <section>
          <h3>SSH (на контроллерах)</h3>
          <p class="muted small" style="margin:0 0 8px">
            Сначала пробуется приватный ключ (если задан), потом фоллбек на пароль.
            Дефолт — <code>root</code> / <code>wirenboard</code>.
          </p>
          <label class="field">
            <span>Пользователь</span>
            <input v-model="sshUser" placeholder="root" />
          </label>
          <label class="field">
            <span>Пароль {{ settings?.sshPasswordConfigured ? '(сохранён)' : '' }}</span>
            <input
              type="password"
              v-model="sshPassword"
              :placeholder="settings?.sshPasswordConfigured ? '••• оставьте пустым чтобы не менять' : 'wirenboard'"
            />
          </label>
          <label class="field">
            <span>Путь к приватному SSH-ключу <span class="muted small">(опционально)</span></span>
            <input v-model="sshKeyPath" :placeholder="`~/.ssh/id_ed25519`" />
          </label>
        </section>

        <section>
          <h3>Интерфейс</h3>
          <label class="field">
            <div class="spread">
              <span>Размер шрифта</span>
              <span class="muted small">{{ fontSize ?? 15 }} px</span>
            </div>
            <input
              type="range" min="12" max="22" step="1"
              :value="fontSize ?? 15"
              @input="emit('fontSizeChange', Number(($event.target as HTMLInputElement).value))"
              style="width:100%; padding:0; background:transparent; border:none;"
            />
          </label>
        </section>

        <section>
          <h3>Прочее</h3>
          <label class="field">
            <span>Период mDNS-сканирования (мс)</span>
            <input type="number" min="3000" step="1000" v-model="discoveryInterval" />
          </label>
        </section>

        <div v-if="saveError" class="error">{{ saveError }}</div>
        <div class="muted small" v-if="settings" style="display:flex;justify-content:space-between;align-items:center;gap:8px;min-width:0">
          <span style="display:flex;align-items:center;gap:4px;min-width:0;overflow:hidden">
            <span style="white-space:nowrap;flex-shrink:0">Файл настроек:</span>
            <code style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block" :title="settings.storagePath">{{ settings.storagePath }}</code>
          </span>
          <span v-if="version" style="white-space:nowrap;flex-shrink:0">v{{ version }}</span>
        </div>
      </div>
      <div class="modal-footer">
        <button class="ghost small" @click="exportSettings" title="Сохранить все настройки в файл">📤 Экспорт</button>
        <input ref="importInput" type="file" accept=".json,application/json" hidden @change="(e: Event) => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) importSettings(f); (e.target as HTMLInputElement).value = '' }" />
        <button class="ghost small" @click="($refs.importInput as HTMLInputElement).click()" title="Загрузить настройки из файла">📥 Импорт</button>
        <span style="flex:1"></span>
        <button @click="emit('close')">Отмена</button>
        <button class="primary" :disabled="saving" @click="save">
          {{ saving ? 'Сохраняю…' : 'Сохранить' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.modal-backdrop {
  position: fixed; inset: 0; background: rgba(0,0,0,0.4);
  display: flex; align-items: center; justify-content: center; z-index: 100;
}
.modal {
  background: var(--bg); border: 1px solid var(--border); border-radius: 10px;
  width: min(900px, 92vw); max-height: 90vh; display: flex; flex-direction: column;
  box-shadow: 0 10px 40px rgba(0,0,0,0.25);
}
.modal-header {
  padding: 12px 16px; border-bottom: 1px solid var(--border);
  display: flex; justify-content: space-between; align-items: center;
}
.modal-header h2 { margin: 0; font-size: 16px; }
.modal-body { padding: 16px; overflow: auto; display: flex; flex-direction: column; gap: 16px; }
.modal-footer {
  padding: 12px 16px; border-top: 1px solid var(--border);
  display: flex; justify-content: flex-end; gap: 8px;
}
section h3 { margin: 0 0 8px 0; font-size: 0.75rem; color: var(--text-mute); text-transform: uppercase; letter-spacing: 0.04em; }
.subsection-label { font-size: 0.7rem; color: var(--text-mute); text-transform: uppercase; letter-spacing: 0.04em; margin: 10px 0 6px; opacity: 0.75; }
.field { display: flex; flex-direction: column; gap: 4px; margin-bottom: 10px; font-size: 0.875rem; }
.field > span { color: var(--text-mute); font-size: 0.8rem; }
.checkbox-field { flex-direction: row; align-items: center; gap: 8px; }
.checkbox-field input[type=checkbox] { width: auto; margin: 0; flex-shrink: 0; }
code { background: var(--bg-mute); padding: 2px 4px; border-radius: 3px; font-size: 0.75rem; word-break: break-all; }
.proxy-auth-row { display: flex; gap: 8px; margin-bottom: 10px; }
.provider-row { display: flex; gap: 6px; flex-wrap: wrap; }
.provider-opt {
  flex: 1;
  display: flex; align-items: center; gap: 6px;
  padding: 6px 10px;
  border: 1px solid var(--border); border-radius: 5px;
  cursor: pointer; user-select: none;
  background: var(--bg);
  transition: border-color 0.1s, background 0.1s;
}
.provider-opt:hover { background: var(--bg-soft); }
.provider-hint { margin: -4px 0 8px; font-size: 0.78rem; }
.provider-opt.active { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 8%, var(--bg)); }
.provider-opt input { width: auto; margin: 0; flex-shrink: 0; }
.key-link {
  margin-left: 8px; font-size: 0.75rem; color: var(--accent);
  text-decoration: none; white-space: nowrap;
}
.key-link:hover { text-decoration: underline; }
.ca-loaded {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding: 6px 10px; border: 1px solid var(--border); border-radius: 4px;
  background: color-mix(in srgb, #22c55e 10%, var(--bg));
  font-size: 0.8rem;
}
.aitunnel-info {
  display: flex; flex-direction: column; gap: 4px;
  padding: 8px 10px; border: 1px solid var(--border); border-radius: 4px;
  background: color-mix(in srgb, var(--accent) 5%, var(--bg));
  margin-bottom: 10px;
  font-size: 0.85rem;
}
.aitunnel-info.aitunnel-low {
  border-color: #ef4444;
  background: color-mix(in srgb, #ef4444 8%, var(--bg));
}
.aitunnel-low-text { color: #ef4444; }
.aitunnel-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.aitunnel-label { color: var(--text-mute); }
.aitunnel-stats { display: flex; flex-wrap: wrap; gap: 6px; }
</style>
