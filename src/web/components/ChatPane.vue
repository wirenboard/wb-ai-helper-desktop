<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { marked } from 'marked'
import type { ChatTurn } from '../api'

marked.use({ breaks: true, gfm: true })

function renderMd(text: string): string {
  return marked.parse(text) as string
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

function send() {
  const t = input.value.trim()
  if (!t || props.streaming) return
  input.value = ''
  emit('send', t)
}

function summaryFor(content: string): string {
  const head = content.split('\n', 1)[0] ?? ''
  return head.length > 80 ? head.slice(0, 80) + '…' : head
}

function onEnter(e: KeyboardEvent) {
  if (e.shiftKey) return
  e.preventDefault()
  send()
}

function scrollBottom() {
  nextTick(() => { if (body.value) body.value.scrollTop = body.value.scrollHeight })
}

watch(() => props.turns.length, scrollBottom)
watch(() => props.turns[props.turns.length - 1]?.content, scrollBottom)
watch(() => props.streaming, (v) => { if (!v) scrollBottom() })
</script>

<template>
  <div class="chat-body" ref="body">
    <div v-if="!turns.length" class="empty">
      Опишите задачу. Например: «список устройств на всех контроллерах»,
      «проверь доступность кухонного контроллера», «какое значение датчика T1 на WB-XXX?».
    </div>
    <template v-for="(t, i) in turns" :key="i">
      <div v-if="t.role === 'user'" class="msg user">
        <div class="role">вы</div>{{ t.content }}
      </div>
      <div v-else-if="t.role === 'assistant'" class="msg assistant">
        <div class="role">помощник</div>
        <div v-if="t.content" class="md" v-html="renderMd(t.content)" />
        <span v-else class="muted">…</span>
        <div v-if="t.tokensPrompt || t.tokensCompletion" class="token-meta">
          ↑{{ t.tokensPrompt ?? 0 }} ↓{{ t.tokensCompletion ?? 0 }}
        </div>
      </div>
      <div v-else-if="t.role === 'tool'" class="msg tool">
        <details>
          <summary>{{ summaryFor(t.content) }}</summary>
          <pre>{{ t.content }}</pre>
        </details>
      </div>
    </template>
  </div>

  <div class="chat-input-row">
    <textarea
      v-model="input"
      :placeholder="llmConfigured ? 'Сообщение… (Enter — отправить, Shift+Enter — перенос)' : 'OPENAI_API_KEY не настроен'"
      :disabled="!llmConfigured"
      @keydown.enter="onEnter"
    />
    <button v-if="streaming" class="danger" @click="emit('stop')">Стоп</button>
    <button v-else class="primary" :disabled="!llmConfigured || !input.trim()" @click="send">
      Отправить
    </button>
  </div>
</template>

<style scoped>
.token-meta {
  margin-top: 4px;
  font-size: 11px;
  color: var(--text-mute);
  opacity: 0.7;
}
.md { line-height: 1.5; }
.md :deep(p) { margin: 0 0 4px; }
.md :deep(p:last-child) { margin-bottom: 0; }
.md :deep(code) {
  background: var(--bg-mute); border-radius: 4px;
  padding: 1px 5px; font-family: ui-monospace, monospace; font-size: 12.5px;
}
.md :deep(pre) {
  background: var(--bg-mute); border-radius: 6px;
  padding: 10px 12px; overflow-x: auto; margin: 4px 0;
}
.md :deep(pre code) { background: none; padding: 0; font-size: 12.5px; }
.md :deep(ul), .md :deep(ol) { margin: 2px 0; padding-left: 18px; }
.md :deep(li) { margin-bottom: 1px; }
.md :deep(li p) { margin: 0; }
.md :deep(strong) { font-weight: 600; }
.md :deep(a) { color: var(--accent); }
.md :deep(blockquote) {
  border-left: 3px solid var(--border); margin: 4px 0;
  padding: 2px 10px; color: var(--text-mute);
}
</style>
