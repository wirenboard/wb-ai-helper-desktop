<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { api, calcCost, contextWindowOf, type Chat, type ChatTurn, type Controller, type Health, type Settings, type TokenStats, type TrackedJob } from './api'
import { fmtCost, fmtTok } from './utils'
import ChatList from './components/ChatList.vue'
import ChatPane from './components/ChatPane.vue'
import ControllerList from './components/ControllerList.vue'
import SettingsPanel from './components/SettingsPanel.vue'
import SshTerminal from './components/SshTerminal.vue'

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
// Индекс первого turn'а текущего стрима в liveTurns. Нужен, чтобы при
// прилёте `usage` события (cumulative-снимок) занулить токены на
// предыдущих assistant-турнах ТОГО же стрима — иначе при многошаговом
// agent-loop'е каждый tool-call создаёт новый empty-assistant в buf, на
// него уходит новый снимок cumulative, и итоговая сумма токенов в шапке
// чата раздувается в N раз. Турны прошлых стримов / persisted из БД сюда
// не входят — у них уже корректные delta-токены.
const streamStartIdx = reactive<{ [chatId: string]: number }>({})
const streaming = ref(false)
const scanning = ref(false)
const errorBanner = ref<string | null>(null)
/** Параметры последней отправки — чтобы кнопка «Повторить» в баннере
 * ошибки могла переотправить тот же запрос. */
const lastSentMessage = ref<{ text: string; opts?: { compact?: boolean } } | null>(null)

async function retryLastMessage() {
  if (!lastSentMessage.value || streaming.value || !activeChat.value) return
  errorBanner.value = null
  // Очищаем retry-events предыдущей попытки из live — без них чат чище.
  const live = liveTurns[activeChat.value.id]
  if (live) {
    for (let i = live.length - 1; i >= 0; i--) {
      const t = live[i]
      if (t?.role === 'user' && t.content.startsWith('[Система] ⏳')) {
        live.splice(i, 1)
      }
      // Удаляем оборванный пустой assistant turn от прошлой попытки —
      // новый стрим напишет в свой свежий пустой assistant.
      else if (t?.role === 'assistant' && !t.content && (!('toolCalls' in t) || !t.toolCalls?.length)) {
        live.splice(i, 1)
      }
    }
  }
  // retryLast: backend НЕ дублирует user-turn в DB. Локально user-msg
  // в live тоже уже на месте, так что просто запускаем стрим заново.
  const id = activeChat.value.id
  const opts = { ...(lastSentMessage.value.opts ?? {}), retryLast: true }
  streaming.value = true
  // Добавляем «свежий» пустой assistant в конец live, куда придёт ответ.
  if (live) live.push({ role: 'assistant', content: '' })
  abortStream = new AbortController()
  try {
    await api.sendMessage(
      id,
      '',
      (event, data) => handleStreamEvent(id, event, data),
      abortStream.signal,
      opts,
    )
  } catch (e: any) {
    if (e?.name !== 'AbortError') errorBanner.value = e.message
  } finally {
    abortStream = null
    if (activeChatId.value === id && activeChat.value?.id === id) {
      const c = await api.getChat(id).catch(() => null)
      if (c) {
        const cur = activeChat.value
        cur.tokensPrompt = c.tokensPrompt
        cur.tokensCompletion = c.tokensCompletion
        cur.tokensCached = c.tokensCached
        cur.totalCost = c.totalCost
        cur.title = c.title
      }
    }
    streaming.value = false
    void api.stats().then((s) => { totalStats.value = s }).catch(() => {})
    void refreshJobs().then(() => {
      if (runningJobs.value.length > 0) startJobPolling()
    })
  }
}

/** Разделяем баннер ошибки на «заголовок» и «детали».
 * formatLlmError на бэке возвращает строки вида:
 *   «Недостаточно средств на счёте провайдера (402). <upstream-текст>»
 *   «LLM error: <текст>»
 * Берём первую часть как title (до первой точки или ":"), остальное — detail. */
function errorTitle(msg: string): string {
  // 1) «… (NNN). xxx» → «… (NNN)»
  const m = msg.match(/^(.+?\(\d{3}\))\.\s/)
  if (m) return m[1]!
  // 2) «Foo: bar» → «Foo»
  const idx = msg.indexOf(':')
  if (idx > 0 && idx < 60) return msg.slice(0, idx)
  // fallback: первое предложение, не длиннее 80 символов
  const dot = msg.indexOf('. ')
  if (dot > 0 && dot < 80) return msg.slice(0, dot)
  return msg.length > 80 ? msg.slice(0, 80) + '…' : msg
}

function errorDetail(msg: string): string {
  const t = errorTitle(msg)
  if (t === msg) return ''
  return msg.slice(t.length).replace(/^[.:\s]+/, '').trim()
}

/** Превращает упоминания http(s)-URL в кликабельные ссылки. Безопасно: всё
 * остальное эскейпится. Используется только на текстах, которые приходят
 * с нашего бэкенда (formatLlmError) — не от модели. */
function linkifyError(text: string): string {
  const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
  const parts: string[] = []
  let lastIdx = 0
  const re = /https?:\/\/[\w./?=&%#:+-]+/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    parts.push(escape(text.slice(lastIdx, m.index)))
    const url = m[0]
    parts.push(`<a href="${escape(url)}" target="_blank" rel="noopener noreferrer">${escape(url)}</a>`)
    lastIdx = m.index + url.length
  }
  parts.push(escape(text.slice(lastIdx)))
  return parts.join('')
}
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

/** Источник правды для всех агрегированных счётчиков чата: liveTurns
 * (там аккумулируется свежее состояние стрима + token-данные после in-place
 * merge), с fallback на activeChat.turns для случая «чат только что выбран
 * и live ещё не сформирован». */
function turnsForCounters(): ChatTurn[] {
  if (!activeChat.value) return []
  return liveTurns[activeChat.value.id] ?? activeChat.value.turns
}

const currentChatTokens = computed(() => {
  return turnsForCounters().reduce(
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

const currentChatTokensCost = computed(() => {
  // Sum of provider-reported tokensCost across assistant turns (VseGPT only — 0 for OpenAI)
  return turnsForCounters().reduce(
    (acc, t) => acc + (t.role === 'assistant' ? (t.tokensCost ?? 0) : 0),
    0,
  )
})

/** Заполнение контекстного окна: берём prompt_tokens ПОСЛЕДНЕГО ответа,
 * а не сумму — это и есть размер текущего активного контекста. */
const currentContextUsage = computed(() => {
  if (!settings.value || !activeChat.value) return null
  const ctx = contextWindowOf(settings.value.model, settings.value.contextWindow)
  if (!ctx) return null
  const turns = turnsForCounters()
  let last = 0
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i]
    if (t?.role === 'assistant' && (t.tokensPrompt ?? 0) > 0) {
      last = t.tokensPrompt!
      break
    }
  }
  if (!last) return null
  return { used: last, total: ctx, ratio: last / ctx }
})

function compactContext() {
  // Просим модель сжать историю — вызвать tool `checkpoint`. Сама модель решит
  // что положить в summary. Текст подсказывающий, остальное — её ответственность.
  // `compact: true` — backend подменит модель на configured compactModel (если задан).
  void sendMessage(
    'Контекст приближается к лимиту. Вызови сейчас checkpoint(summary=...) с кратким итогом текущего этапа, чтобы освободить память.',
    { compact: true },
  )
}

// Авто-сжатие: следим за заполнением контекста и, при превышении порога,
// автоматически отправляем тот же запрос на checkpoint. Дебаунсим, чтобы не
// триггериться на каждом тике, и не запускаемся пока есть активный стрим.
let autoCompactTriggeredForRatio = 0
watch(currentContextUsage, (u) => {
  if (!u || !settings.value?.autoCompact || streaming.value) return
  const threshold = settings.value.autoCompactThreshold || 0.85
  if (u.ratio < threshold) {
    // ratio упал ниже порога (после сжатия) — сбрасываем гард
    autoCompactTriggeredForRatio = 0
    return
  }
  // Уже триггерили на текущем "пике" — ждём пока ratio просядет ниже порога
  if (autoCompactTriggeredForRatio > 0) return
  autoCompactTriggeredForRatio = u.ratio
  compactContext()
})

const currentChatCost = computed(() => {
  if (!settings.value) return null
  const { prompt, completion, cached } = currentChatTokens.value
  if (!prompt && !completion && !currentChatTokensCost.value) return null
  return calcCost(prompt, completion, cached, {
    provider: settings.value.provider,
    tokensCost: currentChatTokensCost.value,
    priceInput: settings.value.priceInput,
    priceOutput: settings.value.priceOutput,
    priceCached: settings.value.priceCached,
  })
})

const totalCost = computed(() => {
  if (!settings.value || !totalStats.value) return null
  const { totalPromptTokens, totalCompletionTokens, totalCachedTokens, totalCost: serverCost } = totalStats.value
  if (!totalPromptTokens && !totalCompletionTokens && !serverCost) return null
  return calcCost(totalPromptTokens, totalCompletionTokens, totalCachedTokens ?? 0, {
    provider: settings.value.provider,
    tokensCost: serverCost,
    priceInput: settings.value.priceInput,
    priceOutput: settings.value.priceOutput,
    priceCached: settings.value.priceCached,
  })
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

/** Авто-сохранение из SettingsPanel (смена провайдера, ввод ключа,
 * импорт, удаление ключа) — обновляем state, окно НЕ закрываем. */
async function onSettingsAutoSaved(next: Settings) {
  settings.value = next
  health.value = await api.health()
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
  // Каждый новый чат — отдельная задача: контекст не наследуется от
  // предыдущего активного чата. Иначе SN «прилипает» из закрытого чата
  // и кажется что приложение само его выбрало.
  const c = await api.createChat([])
  chats.value = [c, ...chats.value.filter((x) => x.id !== c.id)]
  await selectChat(c.id)
}

async function selectChat(id: string) {
  stopJobPolling()
  activeChatId.value = id
  const c = await api.getChat(id)
  activeChat.value = c
  // Live теперь всегда инициализируется полной историей чата (без system),
  // и единственный источник правды для visibleTurns. Без этого пустой live
  // + новый user-msg «затирали» персистентную историю в UI, а после
  // стрима activeChat.turns не обновлялся in-place — UI показывал старое.
  // Копируем каждый turn неглубоко, чтобы мутации в стриме (push,
  // content +=) не задевали activeChat.turns.
  liveTurns[id] = c.turns
    .filter((t) => t.role !== 'system')
    .map((t) => ({ ...t }))
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

const pendingDeleteAll = ref<{
  timer: ReturnType<typeof setTimeout>
  remaining: number
  tick: ReturnType<typeof setInterval>
  /** Snapshot of chats hidden from the sidebar — restored on undo. */
  snapshotChats: Chat[]
  snapshotActiveId: string | null
  snapshotActive: Chat | null
} | null>(null)

function scheduleDeleteAllChats() {
  if (pendingDeleteAll.value) return
  // Stash current state and visually clear the sidebar.
  const snapshotChats = [...chats.value]
  const snapshotActiveId = activeChatId.value
  const snapshotActive = activeChat.value
  chats.value = []
  activeChatId.value = null
  activeChat.value = null
  void newChat()  // give the user an empty chat to type into while undo is available

  const timer = setTimeout(async () => {
    const stash = pendingDeleteAll.value
    if (stash) clearInterval(stash.tick)
    pendingDeleteAll.value = null
    if (!stash) return
    // Commit: actually drop the snapshotted chats on the backend
    for (const c of stash.snapshotChats) await api.deleteChat(c.id).catch(() => {})
    for (const k of Object.keys(liveTurns)) delete liveTurns[k]
    void api.stats().then((s) => { totalStats.value = s }).catch(() => {})
  }, UNDO_DELAY_MS)

  const tick = setInterval(() => {
    if (!pendingDeleteAll.value) return
    pendingDeleteAll.value = { ...pendingDeleteAll.value, remaining: pendingDeleteAll.value.remaining - 1 }
  }, 1000)

  pendingDeleteAll.value = {
    timer, tick,
    remaining: UNDO_DELAY_MS / 1000,
    snapshotChats, snapshotActiveId, snapshotActive,
  }
}

async function undoDeleteAllChats() {
  const stash = pendingDeleteAll.value
  if (!stash) return
  clearTimeout(stash.timer)
  clearInterval(stash.tick)
  pendingDeleteAll.value = null
  // The "filler" chat we created in scheduleDeleteAllChats is unwanted now —
  // it's the only chat in chats.value. Drop it from the backend, then restore the snapshot.
  const filler = chats.value[0]
  if (filler && !stash.snapshotChats.some(c => c.id === filler.id)) {
    await api.deleteChat(filler.id).catch(() => {})
  }
  chats.value = stash.snapshotChats
  if (stash.snapshotActiveId && chats.value.some(c => c.id === stash.snapshotActiveId)) {
    activeChatId.value = stash.snapshotActiveId
    activeChat.value = stash.snapshotActive
  } else if (chats.value.length) {
    await selectChat(chats.value[0]!.id)
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

async function sendMessage(text: string, opts?: { compact?: boolean }) {
  if (!activeChat.value || streaming.value) return
  const id = activeChat.value.id
  streaming.value = true
  errorBanner.value = null
  lastSentMessage.value = { text, ...(opts ? { opts } : {}) }
  const prevHistory = liveTurns[id] ?? activeChat.value.turns.filter((t) => t.role !== 'system')
  liveTurns[id] = [
    ...prevHistory,
    { role: 'user', content: text },
    { role: 'assistant', content: '' },
  ]
  // Запоминаем границу стрима — handleStreamEvent('usage') обнуляет токены
  // только на assistant-турнах от этого индекса до конца buf, не трогая
  // persisted-турны прошлых стримов с уже корректными значениями.
  streamStartIdx[id] = prevHistory.length
  // Гарантируем, что Vue отрисует user-сообщение ДО того, как начнёт
  // приходить первый text-delta стрима. Без этого — если модель отвечает
  // мгновенно, оба обновления (user-msg + первый delta) попадают в один
  // тик и юзер видит свой текст одновременно с ответом, а кажется — что
  // сообщение появилось «после» ответа.
  await nextTick()
  abortStream = new AbortController()
  try {
    await api.sendMessage(
      id,
      text,
      (event, data) => handleStreamEvent(id, event, data),
      abortStream.signal,
      opts,
    )
  } catch (e: any) {
    if (e?.name !== 'AbortError') errorBanner.value = e.message
  } finally {
    abortStream = null
    // Делаем in-place merge вместо полной замены activeChat — иначе
    // Vue пересоздаёт массив turns, ChatMessageList перерендеривает
    // markdown/highlight/mermaid → видимое «дёрганье» чата после стрима.
    // Live-state уже валиден (бэкенд сохранил каждый turn по ходу), нам
    // нужны только агрегированные counters + tokens на последнем assistant.
    if (activeChatId.value === id && activeChat.value?.id === id) {
      const c = await api.getChat(id).catch(() => null)
      if (c) {
        const cur = activeChat.value
        cur.tokensPrompt = c.tokensPrompt
        cur.tokensCompletion = c.tokensCompletion
        cur.tokensCached = c.tokensCached
        cur.totalCost = c.totalCost
        cur.title = c.title
        // Прокидываем tokens на последний assistant_text в liveTurns
        const live = liveTurns[id]
        if (live) {
          for (let i = live.length - 1; i >= 0; i--) {
            const lt = live[i]
            if (lt?.role === 'assistant' && lt.content) {
              const persisted = [...c.turns].reverse().find(
                (t) => t.role === 'assistant' && t.content === lt.content,
              )
              if (persisted && persisted.role === 'assistant') {
                lt.tokensPrompt = persisted.tokensPrompt
                lt.tokensCompletion = persisted.tokensCompletion
                lt.tokensCached = persisted.tokensCached
                lt.tokensCost = persisted.tokensCost
                lt.createdAt = persisted.createdAt
              }
              break
            }
          }
        }
        // НЕ делаем delete liveTurns[id] — оставляем live как источник
        // правды. При перезагрузке страницы / переключении чата selectChat
        // дёрнет api.getChat и наполнит persisted, тогда live можно сбросить.
      }
    }
    streaming.value = false
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
  if (event === 'retry-wait') {
    // Бэк сообщил что провайдер вернул 429 и мы ждём перед повтором.
    // Пишем как system_event прямо в чат (turnsToItems рендерит user-turn
    // c префиксом «[Система]» компактно с шестерёнкой) — тосты сжимаются
    // друг друга и юзер видит только последний, а так остаётся след
    // всех попыток в истории чата для текущего стрима.
    const sec = Math.round((data.delayMs ?? 0) / 1000)
    buf.push({
      role: 'user',
      content: `[Система] ⏳ Провайдер вернул 429 (rate limit). Попытка ${data.attempt}/${data.max}, жду ${sec}с…`,
    })
    return
  }
  if (event === 'usage') {
    // Бэк присылает CUMULATIVE-снимок usage'а после каждой итерации
    // agent-loop'а. Каждый `tool-call` event между итерациями пушит в buf
    // новый empty-assistant, и если просто писать снимок на «последний
    // assistant», на промежуточных empty'ах копятся стейл cumulative-
    // значения от прошлых итераций. `currentChatTokens.reduce` суммирует
    // по всем assistant-турнам — и шапка чата раздувается в N раз
    // (см. v0.13.7 баг: $0.29 в шапке против $0.08 в sidebar/per-message).
    //
    // Фикс: в пределах ТЕКУЩЕГО стрима (от streamStartIdx до конца buf)
    // обнуляем токены на ВСЕХ assistant'ах кроме последнего, а на
    // последний пишем актуальный cumulative. Тогда сумма live-турнов
    // в этом стриме == cumulative последней итерации == реальный billing.
    const start = streamStartIdx[chatId] ?? 0
    let lastAssistantIdx = -1
    for (let i = buf.length - 1; i >= start; i--) {
      if (buf[i]?.role === 'assistant') {
        lastAssistantIdx = i
        break
      }
    }
    for (let i = start; i < buf.length; i++) {
      const t = buf[i]
      if (t?.role !== 'assistant') continue
      if (i === lastAssistantIdx) {
        t.tokensPrompt = data.promptTokens ?? 0
        t.tokensCompletion = data.completionTokens ?? 0
        t.tokensCached = data.cachedTokens ?? 0
        if (typeof data.totalCost === 'number') t.tokensCost = data.totalCost
      } else {
        t.tokensPrompt = 0
        t.tokensCompletion = 0
        t.tokensCached = 0
        delete t.tokensCost
      }
    }
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
    // Immediately show job banner when background job tool responds.
    // We synthesise a TrackedJob entry on the fly so the inline indicator
    // appears instantly — without it, fast jobs (<3 s) finish before our
    // first refreshJobs poll and the user never sees a "running" badge.
    if (data.ok && (data.name === 'ssh_exec_async' || data.name === 'wb_bus_scan' || data.name === 'serial_debug_collect')) {
      try {
        const r = JSON.parse(data.result)
        if (r.jobId && !runningJobs.value.some(j => j.jobId === r.jobId)) {
          let sn = ''
          let label: string = data.name
          try {
            // tool input is in our pendingToolCalls or the previous tool entry —
            // simplest: parse from the tool result envelope if present
            sn = String(r.sn ?? '')
          } catch { /* */ }
          if (!sn) {
            // Try to read from the latest tool input in the buffer
            const toolEntry = buf.find(t => t.role === 'tool' && (t as any).toolCallId === data.id)
            if (toolEntry) {
              const m = toolEntry.content.match(/sn=([A-Z0-9]+)/)
              if (m) sn = m[1] ?? ''
            }
          }
          runningJobs.value = [...runningJobs.value, { jobId: r.jobId, sn: sn || '?', label, sessionId: chatId, state: 'running' }]
          startJobPolling()
          void refreshJobs()
        }
      } catch {}
    }
  }
}

function stopStreaming() {
  abortStream?.abort()
}

const completedJobs = ref<TrackedJob[]>([])

const terminalSn = ref<string | null>(null)

async function refreshJobs() {
  if (!activeChatId.value) return
  try {
    const r = await api.chatJobs(activeChatId.value)
    if (r.jobs?.length) console.log('[jobs] refresh →', r.jobs.map(j => `${j.jobId}/${j.state}`).join(', '))
    const prevRunning = new Set(runningJobs.value.map((j) => j.jobId))
    const nowRunning = r.jobs.filter((j) => j.state === 'running')
    const nowExited = r.jobs.filter((j) => j.state !== 'running' && prevRunning.has(j.jobId))
    // Не пересоздавать массив на каждом тике, если состав не изменился —
    // иначе Vue реактивность каждые 3 секунды дёргает компоненты с
    // running-баннером (computed groupRunningJobs пересчитывается).
    const same = nowRunning.length === runningJobs.value.length
      && nowRunning.every((j, i) => runningJobs.value[i]?.jobId === j.jobId
        && runningJobs.value[i]?.state === j.state)
    if (!same) runningJobs.value = nowRunning

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
  } catch (e) {
    // Транзиентная ошибка (сеть/таймаут) — НЕ сбрасываем runningJobs,
    // иначе баннер «моргает» (исчезает на 1-2 секунды до следующего успешного
    // poll). Реальное завершение задачи приходит штатным ответом, не через
    // catch.
    console.warn('[jobs] refresh failed:', e)
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

/**
 * Pending cancellations: clicking «Отменить» schedules a real cancel 10 s later
 * and shows an undo toast. If the user hits «Отмена» within that window, we
 * just clear the timer — no API call ever fires. This is the Gmail-undo
 * pattern, applied to long-running SSH jobs (which would otherwise be
 * irreversible the moment systemd kills them).
 */
const pendingCancels = ref<Record<string, { timer: ReturnType<typeof setTimeout>; remaining: number }>>({})
let undoTickTimer: ReturnType<typeof setInterval> | null = null
const UNDO_DELAY_MS = 5000

function scheduleCancelJob(jobId: string) {
  if (!activeChatId.value || pendingCancels.value[jobId]) return
  const timer = setTimeout(() => doCancelJob(jobId), UNDO_DELAY_MS)
  pendingCancels.value = {
    ...pendingCancels.value,
    [jobId]: { timer, remaining: UNDO_DELAY_MS / 1000 },
  }
  ensureUndoTicker()
}

function ensureUndoTicker() {
  if (undoTickTimer) return
  undoTickTimer = setInterval(() => {
    const next: typeof pendingCancels.value = {}
    for (const [id, p] of Object.entries(pendingCancels.value)) {
      const r = p.remaining - 1
      if (r > 0) next[id] = { timer: p.timer, remaining: r }
    }
    pendingCancels.value = next
    if (Object.keys(next).length === 0 && undoTickTimer) {
      clearInterval(undoTickTimer); undoTickTimer = null
    }
  }, 1000)
}

function undoCancelJob(jobId: string) {
  const p = pendingCancels.value[jobId]
  if (!p) return
  clearTimeout(p.timer)
  const next = { ...pendingCancels.value }
  delete next[jobId]
  pendingCancels.value = next
}

async function doCancelJob(jobId: string) {
  const next = { ...pendingCancels.value }
  delete next[jobId]
  pendingCancels.value = next
  await cancelJob(jobId)
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
  for (const p of Object.values(pendingCancels.value)) clearTimeout(p.timer)
  if (undoTickTimer) { clearInterval(undoTickTimer); undoTickTimer = null }
})

const visibleTurns = computed<ChatTurn[]>(() => {
  if (!activeChat.value) return []
  // selectChat при выборе чата всегда инициализирует liveTurns[id] полной
  // историей (без system) — live единственный источник правды для рендера.
  // Fallback на persisted остаётся на случай гонки (selectChat ещё не
  // дочитал api.getChat, но computed уже стартовал).
  const live = liveTurns[activeChat.value.id]
  if (live) return live
  return activeChat.value.turns.filter((t) => t.role !== 'system')
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
      :pending-delete-all="pendingDeleteAll"
      @new="newChat"
      @select="selectChat"
      @delete="deleteChat"
      @delete-all="scheduleDeleteAllChats"
      @undo-delete-all="undoDeleteAllChats"
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
          :title="`Сколько потратили токенов в чате (биллинг): ↑${fmtTok(currentChatTokens.prompt)} prompt${currentChatTokens.cached ? ` (⊙${fmtTok(currentChatTokens.cached)} кэш)` : ''} / ↓${fmtTok(currentChatTokens.completion)} completion`"
        >↑{{ fmtTok(currentChatTokens.prompt) }} ↓{{ fmtTok(currentChatTokens.completion) }}<template v-if="currentChatTokens.cached"> ⊙{{ fmtTok(currentChatTokens.cached) }}</template><template v-if="currentChatCost != null"> · {{ fmtCost(currentChatCost) }}</template></div>
        <div
          v-if="currentContextUsage && settings?.autoCompact"
          class="ctx-meter small"
          :class="{ warn: currentContextUsage.ratio >= 0.8, crit: currentContextUsage.ratio >= 0.95 }"
          :title="`Текущий активный контекст ${fmtTok(currentContextUsage.used)} из ${fmtTok(currentContextUsage.total)} (${Math.round(currentContextUsage.ratio * 100)}%)`"
        >
          <span class="ctx-bar"><span class="ctx-fill" :style="{ width: Math.min(100, Math.round(currentContextUsage.ratio * 100)) + '%' }"/></span>
          {{ fmtTok(currentContextUsage.used) }} / {{ fmtTok(currentContextUsage.total) }}
          <button
            v-if="currentContextUsage.ratio >= 0.5 && !streaming"
            class="ctx-compact ghost small"
            title="Сжать историю — модель вызовет checkpoint и заменит старые tool-results кратким суммари"
            @click="compactContext"
          >📦 сжать</button>
        </div>
        <button class="ghost" :title="`Тема: ${themeLabel[theme]}`" @click="cycleTheme">{{ themeIcon[theme] }}</button>
        <button class="ghost" title="Настройки" @click="settingsOpen = true">⚙</button>
      </div>
      <div v-if="errorBanner" class="error-banner">
        <span class="error-icon">⚠</span>
        <div class="error-body">
          <div class="error-title">{{ errorTitle(errorBanner) }}</div>
          <div v-if="errorDetail(errorBanner)" class="error-detail" v-html="linkifyError(errorDetail(errorBanner))"></div>
        </div>
        <button
          v-if="lastSentMessage && !streaming"
          class="error-retry"
          title="Повторить отправку с теми же параметрами"
          @click="retryLastMessage"
        >↻ Повторить</button>
        <button class="error-close ghost small" @click="errorBanner = null" title="Скрыть">×</button>
      </div>
      <!-- Running/done jobs are rendered inline next to the tool group that
           started them (see ChatMessageList) — no need to duplicate here. -->
      <ChatPane
        v-if="activeChat"
        :turns="visibleTurns"
        :streaming="streaming"
        :llm-configured="health?.llmConfigured ?? true"
        :chat-id="activeChat.id"
        :settings="settings"
        :running-jobs="runningJobs"
        @send="sendMessage"
        @stop="stopStreaming"
        @rename="renameChat"
        @cancel-job="scheduleCancelJob"
        :pending-cancels="pendingCancels"
        @undo-cancel-job="undoCancelJob"
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
      @auto-saved="onSettingsAutoSaved"
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
      @open-terminal="terminalSn = $event"
    />
  </div>

  <SshTerminal :sn="terminalSn" @close="terminalSn = null" />

  <Transition name="toast">
    <div v-if="toast" class="toast">{{ toast }}</div>
  </Transition>
</template>

<style scoped>
.error-banner {
  display: flex; align-items: flex-start; gap: 10px;
  padding: 10px 14px; margin: 0;
  border-bottom: 1px solid color-mix(in srgb, #ef4444 40%, transparent);
  background: color-mix(in srgb, #ef4444 8%, var(--bg));
  font-size: 0.85rem; color: var(--text);
}
.error-banner .error-icon {
  font-size: 1.1rem; line-height: 1.2; color: #ef4444; flex-shrink: 0;
  margin-top: 1px;
}
.error-banner .error-body { flex: 1; min-width: 0; }
.error-banner .error-title {
  font-weight: 600; color: #b91c1c;
}
.error-banner :deep(.error-detail) {
  margin-top: 3px; color: var(--text-mute);
  font-size: 0.8rem; line-height: 1.4;
  word-break: break-word;
}
.error-banner :deep(.error-detail a) {
  color: var(--accent); text-decoration: underline;
}
.error-banner .error-retry {
  flex-shrink: 0; align-self: center;
  padding: 4px 10px; font-family: inherit; font-size: 0.8rem;
  background: var(--bg); color: var(--accent);
  border: 1px solid var(--accent); border-radius: 4px; cursor: pointer;
  white-space: nowrap;
}
.error-banner .error-retry:hover {
  background: color-mix(in srgb, var(--accent) 12%, var(--bg));
}
.error-banner .error-close {
  flex-shrink: 0; padding: 0 6px; line-height: 1;
  font-size: 1.2rem; color: var(--text-mute); cursor: pointer;
}
.error-banner .error-close:hover { color: var(--text); }

.toast {
  position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
  background: var(--text); color: var(--bg);
  padding: 8px 18px; border-radius: 20px; font-size: 13px;
  box-shadow: 0 4px 16px rgba(0,0,0,0.2); z-index: 9999; white-space: nowrap;
}
.toast-enter-active, .toast-leave-active { transition: opacity 0.2s, transform 0.2s; }
.toast-enter-from, .toast-leave-to { opacity: 0; transform: translateX(-50%) translateY(8px); }

/* ── Context fill meter ─────────────────────────────────────── */
.ctx-meter {
  display: inline-flex; align-items: center; gap: 6px;
  font-family: 'JetBrains Mono', monospace; font-size: 0.7rem;
  color: var(--text-mute);
}
.ctx-bar {
  display: inline-block; width: 64px; height: 6px;
  background: var(--bg-mute, var(--border)); border-radius: 3px; overflow: hidden;
}
.ctx-fill {
  display: block; height: 100%;
  background: var(--accent);
  transition: width 0.3s ease, background 0.2s ease;
}
.ctx-meter.warn .ctx-fill { background: #d97706; }
.ctx-meter.warn { color: #b45309; }
.ctx-meter.crit .ctx-fill { background: #dc2626; }
.ctx-meter.crit { color: #dc2626; }
.ctx-compact {
  margin-left: 4px; padding: 2px 6px;
  border-radius: 4px; background: var(--bg); border: 1px solid var(--border);
  cursor: pointer; font-family: inherit; font-size: 0.7rem;
}
.ctx-compact:hover { border-color: var(--accent); color: var(--accent); }
</style>
