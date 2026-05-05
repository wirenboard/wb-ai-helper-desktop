<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import type { ChatTurn } from '../api'

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

watch(
  () => [props.turns.length, props.turns[props.turns.length - 1]?.content],
  async () => {
    await nextTick()
    if (body.value) body.value.scrollTop = body.value.scrollHeight
  },
)
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
        <div class="role">помощник</div><span v-if="t.content">{{ t.content }}</span>
        <span v-else class="muted">…</span>
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
