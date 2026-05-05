<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { api, PROVIDER_INFO, type LlmProvider, type Settings } from '../api'
import ComboboxSearch from './ComboboxSearch.vue'

const props = defineProps<{ settings: Settings | null; open: boolean; version?: string; fontSize?: number }>()
const emit = defineEmits<{
  close: []
  saved: [Settings]
  fontSizeChange: [number]
}>()

const provider = ref<LlmProvider>('openai')
const apiKey = ref('')
const baseURL = ref('')
const model = ref('')
const llmProxy = ref('')
const llmProxyUser = ref('')
const llmProxyPassword = ref('')
const tlsInsecure = ref(false)
const priceInput = ref<number | null>(null)
const priceOutput = ref<number | null>(null)
const priceCached = ref<number | null>(null)

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
  apiKey.value = ''
  llmProxyPassword.value = ''
  if (cfg) {
    baseURL.value = cfg.baseURL
    model.value = cfg.model
    llmProxy.value = cfg.llmProxy
    llmProxyUser.value = cfg.llmProxyUser
    tlsInsecure.value = cfg.tlsInsecure
    priceInput.value = cfg.priceInput
    priceOutput.value = cfg.priceOutput
    priceCached.value = cfg.priceCached
  } else {
    baseURL.value = PROVIDER_INFO[next].defaultBaseURL
    model.value = ''
    llmProxy.value = ''
    llmProxyUser.value = ''
    tlsInsecure.value = false
    priceInput.value = null
    priceOutput.value = null
    priceCached.value = null
  }
  // If the loaded baseURL is empty (user never customised), suggest provider's default
  if (!baseURL.value) baseURL.value = PROVIDER_INFO[next].defaultBaseURL
}

function onProviderChange(next: LlmProvider) {
  provider.value = next
  loadProviderFields(next)
  models.value = []
  modelsError.value = null
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

const canFetchModels = computed(() => {
  const hasKey = !!apiKey.value || apiKeyConfiguredForProvider.value
  if (!hasKey) return false
  // Custom requires an explicit Base URL — OpenAI/VseGPT use the hard-coded default
  if (provider.value === 'custom' && !baseURL.value.trim()) return false
  return true
})

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
      if (apiKeyConfiguredForProvider.value) void fetchModels()
    }
  },
  { immediate: true },
)

async function fetchModels() {
  loadingModels.value = true
  modelsError.value = null
  try {
    // Always sync the current UI provider + the bits relevant to /api/models
    // so the backend uses the right provider's key/baseURL for the lookup.
    const patch: any = { provider: provider.value }
    if (apiKey.value) patch.apiKey = apiKey.value
    patch.baseURL = provider.value === 'custom' ? baseURL.value : ''
    await api.saveSettings(patch)
    apiKey.value = ''
    const r = await api.models()
    models.value = r.models
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

async function save() {
  saving.value = true
  saveError.value = null
  try {
    // Only Custom carries an explicit baseURL; OpenAI/VseGPT always use the
    // hard-coded provider default on the backend.
    const baseURLForSave = provider.value === 'custom' ? baseURL.value : ''
    const patch: any = {
      provider: provider.value,
      baseURL: baseURLForSave,
      model: model.value,
      llmProxy: llmProxy.value,
      llmProxyUser: llmProxyUser.value,
      tlsInsecure: tlsInsecure.value,
      mqttUser: mqttUser.value,
      sshUser: sshUser.value,
      sshKeyPath: sshKeyPath.value,
      discoveryInterval: Number(discoveryInterval.value) || 15000,
      openBrowser: openBrowser.value,
      priceInput: priceInput.value != null ? Number(priceInput.value) : null,
      priceOutput: priceOutput.value != null ? Number(priceOutput.value) : null,
      priceCached: priceCached.value != null ? Number(priceCached.value) : null,
    }
    if (apiKey.value) patch.apiKey = apiKey.value
    if (llmProxyPassword.value) patch.llmProxyPassword = llmProxyPassword.value
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
    emit('saved', next)
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
              <label v-for="(info, key) in PROVIDER_INFO" :key="key" class="provider-opt" :class="{ active: provider === key }">
                <input type="radio" :value="key" :checked="provider === key" @change="onProviderChange(key as LlmProvider)" />
                <span>{{ info.label }}</span>
              </label>
            </div>
          </label>
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

          <label v-if="provider === 'custom'" class="field">
            <span>Base URL</span>
            <input v-model="baseURL" :placeholder="baseURLPlaceholder" />
          </label>

          <label class="field">
            <span>Прокси для LLM <span class="muted small">(необязательно)</span></span>
            <input v-model="llmProxy" placeholder="http://proxy-host:8080" />
          </label>
          <div v-if="llmProxy" class="proxy-auth-row">
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
            <div v-else-if="provider === 'custom' && !baseURL.trim()" class="muted small" style="margin-top:4px">
              Укажите Base URL.
            </div>
            <ComboboxSearch
              v-else-if="models.length"
              :modelValue="model"
              :options="models"
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
          <p v-else-if="provider === 'vsegpt'" class="muted small" style="margin:6px 0 0">
            Стоимость приходит от VseGPT в ответе API (₽). Задавать вручную не нужно.
          </p>
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
  width: min(560px, 92vw); max-height: 90vh; display: flex; flex-direction: column;
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
.provider-opt.active { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 8%, var(--bg)); }
.provider-opt input { width: auto; margin: 0; flex-shrink: 0; }
.key-link {
  margin-left: 8px; font-size: 0.75rem; color: var(--accent);
  text-decoration: none; white-space: nowrap;
}
.key-link:hover { text-decoration: underline; }
</style>
