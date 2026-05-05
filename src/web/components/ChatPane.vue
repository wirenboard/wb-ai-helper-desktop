<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { marked } from 'marked'
import type { ChatTurn } from '../api'

marked.use({ breaks: true, gfm: true })

function renderMd(text: string): string {
  const html = marked.parse(text) as string
  return html.replace(/<li>\s*<p>([\s\S]*?)<\/p>\s*<\/li>/g, (_, inner) => `<li>${inner.trim()}</li>`)
}

const props = defineProps<{
  turns: ChatTurn[]
  streaming: boolean
  llmConfigured: boolean
}>()
const emit = defineEmits<{
  send: [text: string]
  stop: []
  rename: [title: string]
}>()

const input = ref('')
const body = ref<HTMLDivElement | null>(null)
const textarea = ref<HTMLTextAreaElement | null>(null)
const copiedIdx = ref<number | null>(null)
const selPopup = ref<{ x: number; y: number } | null>(null)
const selText = ref('')
const selQuote = ref('')  // confirmed quote shown as chip above textarea

function send() {
  const t = input.value.trim()
  if (!t || props.streaming) return
  const msg = selQuote.value ? `«${selQuote.value}»\n\n${t}` : t
  input.value = ''
  selQuote.value = ''
  emit('send', msg)
}

type ToolInfo = { name: string; args: string; result: string }

function toolInfo(turns: ChatTurn[], idx: number): ToolInfo {
  const t = turns[idx]
  if (!t || t.role !== 'tool') return { name: '?', args: '', result: '' }

  // Streaming format written by App.vue: "▶ name\n{args}\n— result —\n{result}"
  if (t.content.startsWith('▶ ')) {
    const lines = t.content.split('\n')
    const name = lines[0]!.slice(2).trim()
    const sep = lines.indexOf('— result —')
    const args = sep > 1 ? lines.slice(1, sep).join('\n') : ''
    const result = sep >= 0 ? lines.slice(sep + 1).join('\n') : t.content
    return { name, args, result }
  }

  // Persisted format: content is raw result. Find tool name + args via toolCallId in sibling assistant turn.
  let name = 'tool'
  let args = ''
  const toolCallId = (t as { toolCallId?: string }).toolCallId
  if (toolCallId) {
    for (let i = idx - 1; i >= 0; i--) {
      const prev = turns[i]
      if (prev?.role === 'assistant' && prev.toolCalls) {
        const tc = prev.toolCalls.find((c) => c.id === toolCallId)
        if (tc) { name = tc.name; args = tc.arguments ?? ''; break }
      }
    }
  }
  return { name, args, result: t.content }
}

function isEmptyArgs(args: string): boolean {
  const t = args.trim()
  return !t || t === '{}' || t === '[]'
}

function onEnter(e: KeyboardEvent) {
  if (e.shiftKey) return
  e.preventDefault()
  send()
}

async function copyMsg(text: string, idx: number) {
  await navigator.clipboard.writeText(text)
  copiedIdx.value = idx
  setTimeout(() => { copiedIdx.value = null }, 1500)
}

function onMouseUp(e: MouseEvent) {
  if ((e.target as HTMLElement).closest('.chat-input-row')) return
  setTimeout(() => {
    const sel = window.getSelection()
    const text = sel?.toString().trim() ?? ''
    if (text.length > 3 && sel?.rangeCount) {
      const rect = sel.getRangeAt(0).getBoundingClientRect()
      selText.value = text
      selPopup.value = { x: rect.left + rect.width / 2, y: rect.top - 6 }
    } else {
      selPopup.value = null
    }
  }, 10)
}

function askSelection() {
  if (!selText.value) return
  selQuote.value = selText.value
  selPopup.value = null
  window.getSelection()?.removeAllRanges()
  nextTick(() => { textarea.value?.focus() })
}

function autoResize() {
  const el = textarea.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = Math.min(el.scrollHeight, 200) + 'px'
}

function scrollBottom() {
  nextTick(() => { if (body.value) body.value.scrollTop = body.value.scrollHeight })
}

watch(() => props.turns.length, scrollBottom)
watch(() => props.turns[props.turns.length - 1]?.content, scrollBottom)
watch(() => props.streaming, (v) => { if (!v) scrollBottom() })
watch(input, autoResize)
</script>

<template>
  <div class="chat-body" ref="body" @mouseup="onMouseUp">
    <div v-if="!turns.length" class="empty">
      Опишите задачу. Например: «список устройств на всех контроллерах»,
      «проверь доступность кухонного контроллера», «какое значение датчика T1 на WB-XXX?».
    </div>
    <template v-for="(t, i) in turns" :key="i">
      <div v-if="t.role === 'user'" class="msg user">
        <div class="role">вы</div>{{ t.content }}
      </div>
      <div
        v-else-if="t.role === 'assistant' && (t.content || (streaming && i === turns.length - 1))"
        class="msg assistant"
      >
        <div class="msg-header">
          <span class="role">помощник</span>
          <button v-if="t.content" class="ghost small copy-btn" :title="copiedIdx === i ? 'Скопировано!' : 'Копировать'" @click="copyMsg(t.content, i)">
            {{ copiedIdx === i ? '✓' : '⎘' }}
          </button>
        </div>
        <div v-if="t.content" class="md" v-html="renderMd(t.content)" />
        <span v-else class="muted">…</span>
        <div v-if="t.tokensPrompt || t.tokensCompletion" class="token-meta">
          ↑{{ t.tokensPrompt ?? 0 }} ↓{{ t.tokensCompletion ?? 0 }}
        </div>
      </div>
      <div v-else-if="t.role === 'tool'" class="msg tool">
        <template v-for="info in [toolInfo(turns, i)]" :key="'info'">
          <details>
            <summary>{{ info.name }}</summary>
            <pre v-if="!isEmptyArgs(info.args)">{{ info.args }}</pre>
            <pre v-if="info.result">{{ info.result }}</pre>
          </details>
        </template>
      </div>
    </template>
  </div>

  <Teleport to="body">
    <div
      v-if="selPopup"
      class="sel-popup"
      :style="{ left: selPopup.x + 'px', top: selPopup.y + 'px' }"
      @mousedown.prevent
    >
      <button class="primary small" @click="askSelection">Спросить →</button>
    </div>
  </Teleport>

  <div class="chat-input-row">
    <div class="input-wrap">
      <div v-if="selQuote" class="quote-bar">
        <span class="quote-text">«{{ selQuote }}»</span>
        <button class="ghost small dismiss-btn" title="Убрать" @click="selQuote = ''">✕</button>
      </div>
      <textarea
        ref="textarea"
        v-model="input"
        :placeholder="llmConfigured ? 'Сообщение… (Enter — отправить, Shift+Enter — перенос)' : 'OPENAI_API_KEY не настроен'"
        :disabled="!llmConfigured"
        @keydown.enter="onEnter"
      />
    </div>
    <button v-if="streaming" class="danger" @click="emit('stop')">Стоп</button>
    <button v-else class="primary" :disabled="!llmConfigured || !input.trim()" @click="send">
      Отправить
    </button>
  </div>
</template>

<style scoped>
.msg-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 2px; }
.msg-header .role { font-size: 11px; color: var(--text-mute); text-transform: uppercase; letter-spacing: 0.04em; }
.copy-btn { padding: 1px 5px; font-size: 12px; opacity: 0; transition: opacity 0.15s; }
.msg:hover .copy-btn { opacity: 1; }
.token-meta { margin-top: 4px; font-size: 11px; color: var(--text-mute); opacity: 0.7; }
.sel-popup {
  position: fixed; transform: translate(-50%, -100%);
  z-index: 500; pointer-events: all;
}
.input-wrap { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.quote-bar {
  display: flex; align-items: flex-start; gap: 6px;
  background: var(--accent-soft); border: 1px solid var(--accent);
  border-bottom: none; border-radius: 6px 6px 0 0;
  padding: 4px 8px; font-size: 12px; color: var(--text-mute);
}
.quote-text { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dismiss-btn { padding: 0 4px; font-size: 11px; color: var(--text-mute); }
.input-wrap textarea {
  border-radius: 6px;
  resize: none;
  height: 40px;
  max-height: 200px;
  overflow-y: auto;
  width: 100%;
}
.input-wrap .quote-bar + textarea {
  border-radius: 0 0 6px 6px;
  border-top: none;
}
</style>
