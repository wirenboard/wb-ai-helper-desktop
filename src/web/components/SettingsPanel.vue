<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { api, type Settings } from '../api'

const props = defineProps<{ settings: Settings | null; open: boolean }>()
const emit = defineEmits<{
  close: []
  saved: [Settings]
}>()

const apiKey = ref('')
const baseURL = ref('')
const model = ref('')
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

const canFetchModels = computed(
  () => !!apiKey.value || !!props.settings?.apiKeyConfigured,
)

watch(
  () => props.open,
  (v) => {
    if (!v) return
    if (props.settings) {
      apiKey.value = ''
      baseURL.value = props.settings.baseURL
      model.value = props.settings.model
      mqttUser.value = props.settings.mqttUser
      mqttPassword.value = ''
      sshUser.value = props.settings.sshUser || 'root'
      sshPassword.value = ''
      sshKeyPath.value = props.settings.sshKeyPath
      discoveryInterval.value = props.settings.discoveryInterval
      openBrowser.value = props.settings.openBrowser
      if (props.settings.apiKeyConfigured) void fetchModels()
    }
  },
  { immediate: true },
)

async function fetchModels() {
  loadingModels.value = true
  modelsError.value = null
  try {
    // If user typed a fresh key, save it first so /api/models can use it.
    if (apiKey.value || baseURL.value !== props.settings?.baseURL) {
      const patch: any = {}
      if (apiKey.value) patch.apiKey = apiKey.value
      if (baseURL.value !== props.settings?.baseURL) patch.baseURL = baseURL.value
      await api.saveSettings(patch)
      apiKey.value = ''
    }
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
    const patch: any = {
      baseURL: baseURL.value,
      model: model.value,
      mqttUser: mqttUser.value,
      sshUser: sshUser.value,
      sshKeyPath: sshKeyPath.value,
      discoveryInterval: Number(discoveryInterval.value) || 15000,
      openBrowser: openBrowser.value,
    }
    if (apiKey.value) patch.apiKey = apiKey.value
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
            <span>API-ключ {{ settings?.apiKeyConfigured ? '(сохранён)' : '(не задан)' }}</span>
            <div class="row">
              <input
                type="password"
                v-model="apiKey"
                :placeholder="settings?.apiKeyConfigured ? '••• оставьте пустым чтобы не менять' : 'sk-...'"
                autocomplete="off"
              />
              <button
                v-if="settings?.apiKeyConfigured"
                class="ghost danger"
                @click="removeKey"
              >удалить</button>
            </div>
          </label>

          <label class="field">
            <span>Base URL <span class="muted small">(оставьте пустым для api.openai.com)</span></span>
            <input v-model="baseURL" placeholder="https://api.openai.com/v1" />
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
            <div v-if="!models.length" class="muted small" style="margin-top:4px">
              Сохраните API-ключ и нажмите «обновить список».
            </div>
            <select v-else v-model="model" style="margin-top:4px">
              <option value="" disabled>— выберите модель —</option>
              <option v-for="m in models" :key="m" :value="m">{{ m }}</option>
            </select>
            <div v-if="modelsError" class="error small">{{ modelsError }}</div>
            <input
              v-model="model"
              placeholder="или впишите имя модели вручную"
              style="margin-top:6px"
            />
          </label>
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
          <h3>Прочее</h3>
          <label class="field">
            <span>Период mDNS-сканирования (мс)</span>
            <input type="number" min="3000" step="1000" v-model="discoveryInterval" />
          </label>
          <label class="field row" style="gap:6px">
            <input type="checkbox" v-model="openBrowser" style="width:auto" />
            <span>открывать браузер при запуске</span>
          </label>
        </section>

        <div v-if="saveError" class="error">{{ saveError }}</div>
        <div class="muted small" v-if="settings">
          Файл настроек: <code>{{ settings.storagePath }}</code>
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
section h3 { margin: 0 0 8px 0; font-size: 13px; color: var(--text-mute); text-transform: uppercase; letter-spacing: 0.04em; }
.field { display: flex; flex-direction: column; gap: 4px; margin-bottom: 10px; font-size: 13px; }
.field > span { color: var(--text-mute); font-size: 12px; }
code { background: var(--bg-mute); padding: 2px 4px; border-radius: 3px; font-size: 11px; word-break: break-all; }
</style>
