<script setup lang="ts">
import { ref, computed, reactive, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import type { ChatItem, ChatItemToolCall } from '../api'
import { fmtSize, plural } from '../utils'
import ChatMessage from './ChatMessage.vue'

const props = defineProps<{
  items: ChatItem[]
  streaming: boolean
  chatId: string
}>()
const emit = defineEmits<{ suggest: [text: string] }>()

const GROUP_THRESHOLD = 3

const SUGGESTIONS = [
  { label: 'Обзор', items: ['Что подключено на шине RS-485?', 'Какая версия прошивки и есть ли обновления?', 'Оцени состояние контроллера'] },
  { label: 'Диагностика', items: ['Найди ошибки в логах за последний час', 'Собери и пришли диагностический архив', 'Выполни диагностику Modbus'] },
  { label: 'Данные', items: ['Пришли график температуры процессора со вчерашнего дня', 'Сделай бэкап контроллера'] },
]

type Group =
  | { kind: 'single'; key: string; item: ChatItem }
  | { kind: 'tools'; key: string; items: ChatItemToolCall[]; startIdx: number }

const groups = computed<Group[]>(() => {
  const out: Group[] = []
  let toolRun: ChatItemToolCall[] = []
  let toolStart = -1

  const flush = () => {
    if (!toolRun.length) return
    if (toolRun.length >= GROUP_THRESHOLD) {
      out.push({ kind: 'tools', key: `g-${toolStart}`, items: toolRun, startIdx: toolStart })
    } else {
      toolRun.forEach((it, k) => out.push({ kind: 'single', key: `i-${toolStart + k}`, item: it }))
    }
    toolRun = []; toolStart = -1
  }

  props.items.forEach((it, i) => {
    if (it.type === 'tool_call') {
      if (!toolRun.length) toolStart = i
      toolRun.push(it)
    } else {
      flush()
      out.push({ kind: 'single', key: `i-${i}`, item: it })
    }
  })
  flush()
  return out
})

const expanded = reactive<Record<string, boolean>>({})
function toggle(key: string) { expanded[key] = !expanded[key] }

const scrollEl = ref<HTMLElement | null>(null)

function scrollToBottom() {
  if (scrollEl.value) scrollEl.value.scrollTop = scrollEl.value.scrollHeight
}

// Scroll when items change (new messages, page load)
watch(() => props.items.length, () => nextTick(scrollToBottom))
watch(() => props.streaming, (v) => { if (!v) nextTick(scrollToBottom) })

let ro: ResizeObserver | null = null
onMounted(async () => {
  await nextTick()
  scrollToBottom()
  if (!scrollEl.value) return
  ro = new ResizeObserver(scrollToBottom)
  Array.from(scrollEl.value.children).forEach(c => ro!.observe(c))
  const mo = new MutationObserver((mutations) => {
    mutations.forEach(m => m.addedNodes.forEach(n => { if (n instanceof Element && ro) ro.observe(n) }))
    scrollToBottom()
  })
  mo.observe(scrollEl.value, { childList: true })
})
onBeforeUnmount(() => ro?.disconnect())
</script>

<template>
  <div ref="scrollEl" class="msg-list">
    <!-- Empty state -->
    <div v-if="!items.length && !streaming" class="empty-state">
      <div v-for="group in SUGGESTIONS" :key="group.label" class="suggestion-group">
        <div class="suggestion-label">{{ group.label }}</div>
        <div class="suggestions">
          <button v-for="s in group.items" :key="s" class="suggestion" @click="emit('suggest', s)">{{ s }}</button>
        </div>
      </div>
    </div>

    <!-- Message groups -->
    <template v-for="g in groups" :key="g.key">
      <ChatMessage v-if="g.kind === 'single'" :item="g.item" :chatId="chatId" />
      <div v-else-if="g.kind === 'tools'" class="tool-group">
        <button class="tool-group-head" @click="toggle(g.key)">
          <span class="caret">{{ expanded[g.key] ? '▾' : '▸' }}</span>
          <span class="tool-group-label">
            {{ g.items.length }} вызов{{ g.items.length < 5 ? (g.items.length === 1 ? '' : 'а') : 'ов' }} инструментов
          </span>
          <span class="tool-group-names">{{ [...new Set(g.items.map(i => i.name))].join(', ') }}</span>
        </button>
        <div v-if="expanded[g.key]" class="tool-group-body">
          <ChatMessage v-for="(it, k) in g.items" :key="k" :item="it" :chatId="chatId" />
        </div>
      </div>
    </template>

    <!-- Typing indicator -->
    <div v-if="streaming" class="typing">
      <span class="dot"></span><span class="dot"></span><span class="dot"></span>
    </div>
  </div>
</template>

<style scoped>
.msg-list { flex: 1; overflow-y: auto; padding: 8px 14px 16px; display: flex; flex-direction: column; }

/* ── Empty state ────────────────────────────────────────────── */
.empty-state { display: flex; flex-direction: column; align-items: center; gap: 12px; margin-top: 24px; }
.suggestion-group { display: flex; flex-direction: column; align-items: center; gap: 6px; width: 100%; max-width: 560px; }
.suggestion-label { font-size: 0.6875rem; font-weight: 600; color: var(--text-mute); text-transform: uppercase; letter-spacing: 0.5px; }
.suggestions { display: flex; flex-wrap: wrap; justify-content: center; gap: 6px; }
.suggestion {
  padding: 5px 13px; background: var(--bg); border: 1px solid var(--border);
  border-radius: 14px; font-family: inherit; font-size: 0.8125rem; color: var(--text-mute);
  cursor: pointer; transition: all 0.15s;
}
.suggestion:hover { background: var(--bg-soft); border-color: var(--accent); color: var(--accent); }

/* ── Tool group ─────────────────────────────────────────────── */
.tool-group { margin: 4px 0; }
.tool-group-head {
  display: flex; align-items: center; gap: 6px; width: 100%;
  padding: 4px 8px; background: var(--bg-soft); border: 1px dashed var(--border);
  border-radius: 4px; cursor: pointer; font-size: 0.75rem; color: var(--text-mute); text-align: left;
}
.tool-group-head:hover { background: var(--bg-mute); }
.caret { width: 10px; color: var(--text-mute); }
.tool-group-label { font-weight: 600; color: var(--text); }
.tool-group-names { color: var(--accent); font-family: 'JetBrains Mono', monospace; font-size: 0.6875rem; margin-left: auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tool-group-body { margin-top: 4px; padding-left: 12px; border-left: 2px solid var(--border); }

/* ── Typing dots ────────────────────────────────────────────── */
.typing { display: inline-flex; gap: 3px; margin: 6px 4px; }
.dot { width: 6px; height: 6px; background: var(--text-mute); border-radius: 50%; animation: blink 1.2s infinite; }
.dot:nth-child(2) { animation-delay: 0.2s; }
.dot:nth-child(3) { animation-delay: 0.4s; }
@keyframes blink { 0%, 60%, 100% { opacity: 0.3; } 30% { opacity: 1; } }
</style>
