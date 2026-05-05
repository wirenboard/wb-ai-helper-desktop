<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { api, type Chat, type ChatTurn, type Controller, type Health, type Settings, type TokenStats } from './api'
import { fmtTok } from './utils'
import ChatList from './components/ChatList.vue'
import ChatPane from './components/ChatPane.vue'
import ControllerList from './components/ControllerList.vue'
import SettingsPanel from './components/SettingsPanel.vue'

const leftOpen = ref(true)
const rightOpen = ref(true)
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
const totalStats = ref<TokenStats | null>(null)
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
      }
      return acc
    },
    { prompt: 0, completion: 0 },
  )
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
    if (event === 'controllers') controllers.value = data
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
  try {
    const r = await api.refresh()
    controllers.value = r.controllers
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
  activeChatId.value = id
  const c = await api.getChat(id)
  activeChat.value = c
  if (!liveTurns[id]) liveTurns[id] = []
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
  liveTurns[id] = [
    ...(liveTurns[id] ?? []),
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
      if (c) patchLocalChat(c)
    }
    void api.stats().then((s) => { totalStats.value = s }).catch(() => {})
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
    if (idx >= 0) {
      buf[idx] = {
        role: 'tool',
        toolCallId: data.id,
        content: `${buf[idx]!.content}\n— result —\n${data.result}`,
      }
    } else {
      buf.push({ role: 'tool', toolCallId: data.id, content: data.result })
    }
  }
}

function stopStreaming() {
  abortStream?.abort()
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
})

const visibleTurns = computed<ChatTurn[]>(() => {
  if (!activeChat.value) return []
  const persisted = activeChat.value.turns.filter((t) => t.role !== 'system')
  const live = liveTurns[activeChat.value.id] ?? []
  // Persisted is updated after the stream ends; while streaming, show live.
  return streaming.value ? live : persisted.length ? persisted : live
})
</script>

<template>
  <div class="app-shell" :style="{ gridTemplateColumns: gridCols }">
    <ChatList
      :chats="chats"
      :active-id="activeChatId"
      :total-stats="totalStats"
      :open="leftOpen"
      @new="newChat"
      @select="selectChat"
      @delete="deleteChat"
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
          title="Токены в этом чате: ↑ prompt / ↓ completion"
        >↑{{ fmtTok(currentChatTokens.prompt) }} ↓{{ fmtTok(currentChatTokens.completion) }}</div>
        <button class="ghost" title="Настройки" @click="settingsOpen = true">⚙</button>
      </div>
      <div v-if="errorBanner" class="error">{{ errorBanner }}</div>
      <ChatPane
        v-if="activeChat"
        :turns="visibleTurns"
        :streaming="streaming"
        :llm-configured="health?.llmConfigured ?? true"
        @send="sendMessage"
        @stop="stopStreaming"
        @rename="renameChat"
      />
      <div v-else class="welcome">
        <h2>WB AI Helper</h2>
        <p>Помощник интегратора Wiren Board. Создайте чат слева — справа выберите контроллеры из локальной сети.</p>
        <button class="primary" @click="settingsOpen = true">Настройки</button>
      </div>
    </div>

    <div v-if="rightOpen" class="resize-handle" @mousedown="startResize('right', $event)" />
    <div v-else style="width:4px" />

    <SettingsPanel
      :settings="settings"
      :open="settingsOpen"
      :version="health?.version"
      @close="settingsOpen = false"
      @saved="onSettingsSaved"
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
</template>
