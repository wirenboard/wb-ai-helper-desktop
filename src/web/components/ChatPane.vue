<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { type ChatTurn, turnsToItems, type TrackedJob } from '../api'
import ChatMessageList from './ChatMessageList.vue'
import ChatInputArea from './ChatInputArea.vue'

const props = defineProps<{
  turns: ChatTurn[]
  streaming: boolean
  llmConfigured: boolean
  chatId: string
  runningJobs?: TrackedJob[]
}>()
const emit = defineEmits<{
  send: [text: string]
  stop: []
  rename: [title: string]
  cancelJob: [jobId: string]
}>()

const items = computed(() => turnsToItems(props.turns, props.chatId))

// Text selection → quote
const selPopup = ref<{ x: number; y: number; text: string } | null>(null)
const inputAreaRef = ref<InstanceType<typeof ChatInputArea> | null>(null)

function onSelectionChange() {
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed || !sel.toString().trim()) { selPopup.value = null; return }
  const range = sel.getRangeAt(0)
  const rect = range.getBoundingClientRect()
  selPopup.value = { x: rect.left + rect.width / 2, y: rect.top - 4, text: sel.toString().trim() }
}

function quoteSelection() {
  if (!selPopup.value) return
  inputAreaRef.value?.setQuote(selPopup.value.text)
  selPopup.value = null
  window.getSelection()?.removeAllRanges()
}

function onDocMousedown(e: MouseEvent) {
  const popup = document.querySelector('.sel-popup')
  if (popup && !popup.contains(e.target as Node)) selPopup.value = null
}
window.addEventListener('mousedown', onDocMousedown)
onBeforeUnmount(() => window.removeEventListener('mousedown', onDocMousedown))

function onSuggest(text: string) {
  emit('send', text)
}
</script>

<template>
  <div class="chat-pane-inner">
    <ChatMessageList
      :items="items"
      :streaming="streaming"
      :chatId="chatId"
      :runningJobs="runningJobs"
      @mouseup="onSelectionChange"
      @suggest="onSuggest"
      @cancelJob="emit('cancelJob', $event)"
    />

    <Teleport to="body">
      <div v-if="selPopup" class="sel-popup" :style="{ left: selPopup.x + 'px', top: selPopup.y + 'px' }">
        <button @mousedown.prevent="quoteSelection">Спросить →</button>
      </div>
    </Teleport>

    <ChatInputArea
      ref="inputAreaRef"
      :disabled="streaming"
      :llmConfigured="llmConfigured"
      :chatId="chatId"
      @send="emit('send', $event)"
      @abort="emit('stop')"
    />
  </div>
</template>

<style scoped>
.chat-pane-inner {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}
.sel-popup {
  position: fixed;
  transform: translate(-50%, -100%);
  z-index: 1000;
}
.sel-popup button {
  background: #1e293b;
  color: #fff;
  border: none;
  padding: 4px 12px;
  border-radius: 4px;
  font-size: 0.75rem;
  cursor: pointer;
  box-shadow: 0 2px 8px rgba(0,0,0,0.2);
}
.sel-popup button:hover { background: #334155; }
</style>
