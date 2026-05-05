<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { api, calcCost, type Chat, type ChatTurn, type Controller, type Health, type Settings, type TokenStats, type TrackedJob } from './api'
import { fmtCost, fmtTok } from './utils'
import ChatList from './components/ChatList.vue'
import ChatPane from './components/ChatPane.vue'
import ControllerList from './components/ControllerList.vue'
import SettingsPanel from './components/SettingsPanel.vue'

const leftOpen = ref(true)
const rightOpen = ref(true)

type Theme = 'auto' | 'light' | 'dark'
const THEME_KEY = 'wb-theme'
const themeOrder: Theme[] = ['auto', 'light', 'dark']
const themeIcon: Record<Theme, string> = { auto: '◑', light: '☀', dark: '☾' }
const themeLabel: Record<Theme, string> = { auto: 'Авто', light: 'Светлая', dark: 'Тёмная' }

const theme = ref<Theme>((localStorage.getItem(THEME_KEY) as Theme) ?? 'auto')

function applyTheme(t: Theme) {
  if (t === 'auto') delete document.documentElement.dataset['theme']
  else document.documentElement.dataset['theme'] = t
}

function cycleTheme() {
  const next = themeOrder[(themeOrder.indexOf(theme.value) + 1) % themeOrder.length]!
  theme.value = next
  localStorage.setItem(THEME_KEY, next)
  applyTheme(next)
}

applyTheme(theme.value)

const FONT_SIZE_KEY = 'wb-font-size'
const fontSize = ref<number>(Number(localStorage.getItem(FONT_SIZE_KEY)) || 18)

function applyFontSize(s: number) {
  document.documentElement.style.fontSize = s + 'px'
}

function onFontSizeChange(s: number) {
  fontSize.value = s
  localStorage.setItem(FONT_SIZE_KEY, String(s))
  applyFontSize(s)
}

applyFontSize(fontSize.value)

const leftWidth = ref(260)
const rightWidth = ref(320)

const gridCols = computed(() =>
  `${leftOpen.value ? leftWidth.value + 'px' : '28px'} 4px 1fr 4px ${rightOpen.value ? rightWidth.value + 'px' : '28px'}`,
)

let resizing: 'left' | 'right' | null = null
let resizeStartX = 0
let resizeStartW = 0

function startResize(side: 'left' | 'right', e: MouseEvent) {
  resizing = side
  resizeStartX = e.clientX
  resizeStartW = side === 'left' ? leftWidth.value : rightWidth.value
  window.addEventListener('mousemove', onMouseMove)
  window.addEventListener('mouseup', stopResize, { once: true })
  e.preventDefault()
}

function onMouseMove(e: MouseEvent) {
  if (!resizing) return
  const dx = e.clientX - resizeStartX
  if (resizing === 'left') leftWidth.value = Math.max(160, Math.min(520, resizeStartW + dx))
  else rightWidth.value = Math.max(200, Math.min(520, resizeStartW - dx))
}

function stopResize() {
  resizing = null
  window.removeEventListener('mousemove', onMouseMove)
}

onBeforeUnmount(() => window.removeEventListener('mousemove', onMouseMove))

const health = ref<Health | null>(null)
const settings = ref<Settings | null>(null)
const settingsOpen = ref(false)
const controllers = ref<Controller[]>([])
const chats = ref<Chat[]>([])
const activeChatId = ref<string | null>(null)
const activeChat = ref<Chat | null>(null)
const liveTurns = reactive<{ [chatId: string]: ChatTurn[] }>({})
const streaming = ref(false)
const scanning = ref(false)
const errorBanner = ref<string | null>(null)
const toast = ref<string | null>(null)
let toastTimer: ReturnType<typeof setTimeout> | null = null

function showToast(msg: string, ms = 3000) {
  toast.value = msg
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toast.value = null }, ms)
}
const totalStats = ref<TokenStats | null>(null)
const runningJobs = ref<TrackedJob[]>([])
let jobPollTimer: ReturnType<typeof setInterval> | null = null
let unsubscribe: (() => void) | null = null
let abortStream: AbortController | null = null

const selectedSns = computed(() => activeChat.value?.contextSns ?? [])

const currentChatTokens = computed(() => {
  const turns = activeChat.value?.turns ?? []
  return turns.reduce(
    (acc, t) => {
      if (t.role === 'assistant') {
        acc.prompt += t.tokensPrompt ?? 0
        acc.completion += t.tokensCompletion ?? 0
        acc.cached += t.tokensCached ?? 0
      }
      return acc
    },
    { prompt: 0, completion: 0, cached: 0 },
  )
})

const currentChatCost = computed(() => {
  if (!settings.value) return null
  const { prompt, completion, cached } = currentChatTokens.value
  if (!prompt && !completion) return null
  return calcCost(prompt, completion, cached, settings.value)
})

const totalCost = computed(() => {
  if (!settings.value || !totalStats.value) return null
  const { totalPromptTokens, totalCompletionTokens, totalCachedTokens } = totalStats.value
  if (!totalPromptTokens && !totalCompletionTokens) return null
  return calcCost(totalPromptTokens, totalCompletionTokens, totalCachedTokens ?? 0, settings.value)
})


async function loadInitial() {
  try {
    const [h, s] = await Promise.all([api.health(), api.settings()])
    health.value = h
    settings.value = s
    if (!h.llmConfigured) settingsOpen.value = true
  } catch (e: any) {
    errorBanner.value = `Бэкенд недоступен: ${e.message}`
    return
  }
  await refreshControllers()
  await refreshChats()
  void api.stats().then((s) => { totalStats.value = s }).catch(() => {})
  if (!chats.value.length) {
    await newChat()
  } else {
    await selectChat(chats.value[0]!.id)
  }
  unsubscribe = api.subscribeEvents((event, data) => {
    if (event === 'controllers') controllers.value = data as Controller[]
  })
}

async function onSettingsSaved(next: Settings) {
  settings.value = next
  health.value = await api.health()
  if (next.apiKeyConfigured && next.model) settingsOpen.value = false
}

async function refreshControllers() {
  const r = await api.controllers()
  controllers.value = r.controllers
}

async function rescan() {
  scanning.value = true
  showToast('Сканирую сеть…')
  try {
    const r = await api.refresh()
    controllers.value = r.controllers
    const n = r.controllers.length
    showToast(n ? `Нашёл ${n} контроллер${n === 1 ? '' : n < 5 ? 'а' : 'ов'}` : 'Ничего не нашли')
  } catch (e: any) {
    showToast(`Ошибка сканирования: ${e?.message ?? String(e)}`)
  } finally {
    scanning.value = false
  }
}

async function refreshChats() {
  const r = await api.chats()
  chats.value = r.chats
}

async function newChat() {
  const c = await api.createChat([...selectedSns.value])
  chats.value = [c, ...chats.value.filter((x) => x.id !== c.id)]
  await selectChat(c.id)
}

async function selectChat(id: string) {
  stopJobPolling()
  activeChatId.value = id
  const c = await api.getChat(id)
  activeChat.value = c
  if (!liveTurns[id]) liveTurns[id] = []
  void refreshJobs().then(() => {
    if (runningJobs.value.length > 0) startJobPolling()
  })
}

async function deleteChat(id: string) {
  await api.deleteChat(id)
  delete liveTurns[id]
  chats.value = chats.value.filter((c) => c.id !== id)
  if (activeChatId.value === id) {
    activeChatId.value = null
    activeChat.value = null
    if (chats.value.length) await selectChat(chats.value[0]!.id)
    else await newChat()
  }
}

function patchLocalChat(c: Chat) {
  activeChat.value = c
  chats.value = chats.value.map((x) => (x.id === c.id ? c : x))
}

async function setChatContext(sns: string[]) {
  if (!activeChatId.value) return
  patchLocalChat(await api.patchChat(activeChatId.value, { contextSns: sns }))
}

async function renameChat(title: string) {
  if (!activeChatId.value) return
  patchLocalChat(await api.patchChat(activeChatId.value, { title }))
}

async function sendMessage(text: string) {
  if (!activeChat.value || streaming.value) return
  const id = activeChat.value.id
  streaming.value = true
  errorBanner.value = null
  const prevHistory = liveTurns[id] ?? activeChat.value.turns.filter((t) => t.role !== 'system')
  liveTurns[id] = [
    ...prevHistory,
    { role: 'user', content: text },
    { role: 'assistant', content: '' },
  ]
  abortStream = new AbortController()
  try {
    await api.sendMessage(
      id,
      text,
      (event, data) => handleStreamEvent(id, event, data),
      abortStream.signal,
    )
  } catch (e: any) {
    if (e?.name !== 'AbortError') errorBanner.value = e.message
  } finally {
    streaming.value = false
    abortStream = null
    if (activeChatId.value === id) {
      const c = await api.getChat(id).catch(() => null)
      if (c) {
        patchLocalChat(c)
        delete liveTurns[id]  // persisted is now fresh, drop live
      }
    }
    void api.stats().then((s) => { totalStats.value = s }).catch(() => {})
    // Start polling for background jobs after LLM response
    void refreshJobs().then(() => {
      if (runningJobs.value.length > 0) startJobPolling()
    })
  }
}

function handleStreamEvent(chatId: string, event: string, data: any) {
  const buf = liveTurns[chatId]
  if (!buf) return
  if (event === 'error') {
    errorBanner.value = data?.message ?? String(data)
    return
  }
  if (event === 'text-delta') {
    const last = buf[buf.length - 1]
    if (last?.role === 'assistant') last.content += data.text
    return
  }
  if (event === 'tool-call') {
    buf.push({
      role: 'tool',
      toolCallId: data.id,
      content: `▶ ${data.name}\n${pretty(data.arguments)}`,
    })
    buf.push({ role: 'assistant', content: '' })
    return
  }
  if (event === 'tool-result') {
    const idx = buf.findIndex(
      (t) => t.role === 'tool' && (t as any).toolCallId === data.id,
    )
    const sep = data.ok === false ? '— result err —' : '— result —'
    if (idx >= 0) {
      buf[idx] = {
        role: 'tool',
        toolCallId: data.id,
        content: `${buf[idx]!.content}\n${sep}\n${data.result}`,
      }
    } else {
      buf.push({ role: 'tool', toolCallId: data.id, content: data.result })
    }
  }
}

function stopStreaming() {
  abortStream?.abort()
}

const completedJobs = ref<TrackedJob[]>([])

async function refreshJobs() {
  if (!activeChatId.value) return
  try {
    const r = await api.chatJobs(activeChatId.value)
    const prevRunning = new Set(runningJobs.value.map((j) => j.jobId))
    const nowRunning = r.jobs.filter((j) => j.state === 'running')
    const nowExited = r.jobs.filter((j) => j.state !== 'running' && prevRunning.has(j.jobId))
    runningJobs.value = nowRunning

    for (const job of nowExited) {
      completedJobs.value = [...completedJobs.value, job]
      setTimeout(() => {
        completedJobs.value = completedJobs.value.filter((j) => j.jobId !== job.jobId)
      }, 8000)
      // Auto-send to model only if not currently streaming
      if (!streaming.value && activeChatId.value) {
        await sendMessage(`[Система] Фоновая задача завершена: jobId=${job.jobId}, "${job.label}", контроллер ${job.sn}. Проверь результат через job_tail и сообщи пользователю итог.`)
      }
    }

    if (nowRunning.length === 0 && nowExited.length === 0 && !streaming.value) {
      stopJobPolling()
    }
  } catch {
    runningJobs.value = []
  }
}

function startJobPolling() {
  if (jobPollTimer) return
  jobPollTimer = setInterval(() => void refreshJobs(), 3000)
}

function stopJobPolling() {
  if (jobPollTimer) { clearInterval(jobPollTimer); jobPollTimer = null }
  runningJobs.value = []
}

async function cancelJob(jobId: string) {
  if (!activeChatId.value) return
  try {
    await api.cancelJob(activeChatId.value, jobId)
    await refreshJobs()
  } catch (e: any) {
    showToast(`Ошибка отмены задачи: ${e?.message ?? String(e)}`)
  }
}

function pretty(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2)
  } catch {
    return s
  }
}

onMounted(loadInitial)
onBeforeUnmount(() => {
  unsubscribe?.()
  abortStream?.abort()
  stopJobPolling()
})

const visibleTurns = computed<ChatTurn[]>(() => {
  if (!activeChat.value) return []
  const persisted = activeChat.value.turns.filter((t) => t.role !== 'system')
  const live = liveTurns[activeChat.value.id] ?? []
  // Prefer live while it has content; after getChat refreshes persisted, live is deleted
  return live.length ? live : persisted
})
</script>

<template>
  <div class="app-shell" :style="{ gridTemplateColumns: gridCols }">
    <ChatList
      :chats="chats"
      :active-id="activeChatId"
      :total-stats="totalStats"
      :total-cost="totalCost"
      :settings="settings"
      :open="leftOpen"
      @new="newChat"
      @select="selectChat"
      @delete="deleteChat"
      @rename="(id, title) => api.patchChat(id, { title }).then(patchLocalChat)"
      @toggle="leftOpen = !leftOpen"
    />

    <div v-if="leftOpen" class="resize-handle" @mousedown="startResize('left', $event)" />
    <div v-else style="width:4px" />

    <div class="chat-pane">
      <div class="chat-header" v-if="activeChat">
        <div class="chat-title" :title="activeChat.title">{{ activeChat.title }}</div>
        <div class="chat-context small">
          <span v-if="!activeChat.contextSns.length" class="muted">Контекст: все/выбрать справа →</span>
          <span v-else class="context-chips">
            <span class="chip" v-for="sn in activeChat.contextSns" :key="sn">{{ sn }}</span>
          </span>
        </div>
        <div
          v-if="currentChatTokens.prompt + currentChatTokens.completion"
          class="chat-tokens small muted"
          :title="`Токены в этом чате: ↑${fmtTok(currentChatTokens.prompt)} prompt${currentChatTokens.cached ? ` (⊙${fmtTok(currentChatTokens.cached)} кэш)` : ''} / ↓${fmtTok(currentChatTokens.completion)} completion`"
        >↑{{ fmtTok(currentChatTokens.prompt) }} ↓{{ fmtTok(currentChatTokens.completion) }}<template v-if="currentChatTokens.cached"> ⊙{{ fmtTok(currentChatTokens.cached) }}</template><template v-if="currentChatCost != null"> · {{ fmtCost(currentChatCost) }}</template></div>
        <button class="ghost small" title="Новый чат" @click="newChat" style="white-space:nowrap">+ Новый</button>
        <button class="ghost" :title="`Тема: ${themeLabel[theme]}`" @click="cycleTheme">{{ themeIcon[theme] }}</button>
        <button class="ghost" title="Настройки" @click="settingsOpen = true">⚙</button>
      </div>
      <div v-if="errorBanner" class="error">{{ errorBanner }}</div>
      <div v-for="job in runningJobs" :key="job.jobId" class="job-banner job-banner--running">
        <span class="job-spinner">⟳</span>
        <span class="job-label">{{ job.label }} <span class="job-sn">{{ job.sn }}</span></span>
        <button class="job-cancel ghost small" @click="cancelJob(job.jobId)" title="Отменить задачу">✕ Отменить</button>
      </div>
      <div v-for="job in completedJobs" :key="job.jobId" class="job-banner job-banner--done">
        <span>✓ Задача завершена: {{ job.label }}</span>
      </div>
      <ChatPane
        v-if="activeChat"
        :turns="visibleTurns"
        :streaming="streaming"
        :llm-configured="health?.llmConfigured ?? true"
        :chat-id="activeChat.id"
        @send="sendMessage"
        @stop="stopStreaming"
        @rename="renameChat"
      />
      <div v-else class="welcome">
        <h2>WB AI Helper</h2>
        <p>Помощник интегратора Wiren Board. Создайте чат слева — справа выберите контроллеры из локальной сети.</p>
        <div style="display:flex;gap:8px;justify-content:center">
          <button class="primary" @click="settingsOpen = true">Настройки</button>
          <button @click="cycleTheme" :title="`Тема: ${themeLabel[theme]}`">{{ themeIcon[theme] }} {{ themeLabel[theme] }}</button>
        </div>
      </div>
    </div>

    <div v-if="rightOpen" class="resize-handle" @mousedown="startResize('right', $event)" />
    <div v-else style="width:4px" />

    <SettingsPanel
      :settings="settings"
      :open="settingsOpen"
      :version="health?.version"
      :font-size="fontSize"
      @close="settingsOpen = false"
      @saved="onSettingsSaved"
      @font-size-change="onFontSizeChange"
    />

    <ControllerList
      :controllers="controllers"
      :selected="selectedSns"
      :open="rightOpen"
      :scanning="scanning"
      @toggle-panel="rightOpen = !rightOpen"
      @rescan="rescan"
      @add-manual="(host) => api.addController(host).then(refreshControllers)"
      @remove="(sn) => api.removeController(sn).then(refreshControllers)"
      @toggle="(sn) => {
        const cur = new Set(selectedSns)
        if (cur.has(sn)) cur.delete(sn); else cur.add(sn)
        setChatContext([...cur])
      }"
      @select-all="setChatContext(controllers.map((c) => c.sn))"
      @clear="setChatContext([])"
    />
  </div>

  <Transition name="toast">
    <div v-if="toast" class="toast">{{ toast }}</div>
  </Transition>
</template>

<style scoped>
.toast {
  position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
  background: var(--text); color: var(--bg);
  padding: 8px 18px; border-radius: 20px; font-size: 13px;
  box-shadow: 0 4px 16px rgba(0,0,0,0.2); z-index: 9999; white-space: nowrap;
}
.toast-enter-active, .toast-leave-active { transition: opacity 0.2s, transform 0.2s; }
.toast-enter-from, .toast-leave-to { opacity: 0; transform: translateX(-50%) translateY(8px); }

.job-banner {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 12px; font-size: 0.8rem;
  border-bottom: 1px solid var(--border);
}
.job-banner--running {
  background: color-mix(in srgb, var(--primary) 12%, var(--bg));
  color: var(--primary);
}
.job-banner--done {
  background: color-mix(in srgb, #22c55e 12%, var(--bg));
  color: #16a34a;
}
.job-spinner {
  display: inline-block;
  animation: spin 1.2s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
.job-label { flex: 1; }
.job-sn { opacity: 0.7; font-size: 0.75em; }
.job-cancel { margin-left: auto; color: inherit; border-color: currentColor; }
</style>
