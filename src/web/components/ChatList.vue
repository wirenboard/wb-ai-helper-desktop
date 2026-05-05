<script setup lang="ts">
import { nextTick, ref } from 'vue'
import type { Chat, TokenStats } from '../api'
import { fmtTok } from '../utils'

defineProps<{ chats: Chat[]; activeId: string | null; totalStats: TokenStats | null; open: boolean }>()
const emit = defineEmits<{
  new: []
  select: [id: string]
  delete: [id: string]
  rename: [id: string, title: string]
  toggle: []
}>()

const renaming = ref<string | null>(null)
const renameVal = ref('')
const renameInput = ref<HTMLInputElement | null>(null)

function startRename(c: Chat, e: MouseEvent) {
  e.stopPropagation()
  renaming.value = c.id
  renameVal.value = c.title
  nextTick(() => { renameInput.value?.select() })
}

function confirmRename(id: string) {
  const t = renameVal.value.trim()
  if (t) emit('rename', id, t)
  renaming.value = null
}

function onRenameKey(e: KeyboardEvent, id: string) {
  if (e.key === 'Enter') confirmRename(id)
  if (e.key === 'Escape') renaming.value = null
}
</script>

<template>
  <aside class="sidebar" :class="{ collapsed: !open }">
    <div class="sidebar-header">
      <template v-if="open">
        <span>Чаты</span>
        <button class="primary" @click="emit('new')" title="Новый чат">+ Новый</button>
      </template>
      <button class="ghost collapse-btn" :title="open ? 'Свернуть' : 'Развернуть'" @click="emit('toggle')">
        {{ open ? '‹' : '›' }}
      </button>
    </div>
    <template v-if="open">
      <div class="sidebar-body">
        <div v-if="!chats.length" class="empty">Чатов пока нет</div>
        <div
          v-for="c in chats"
          :key="c.id"
          class="chat-list-item"
          :class="{ active: c.id === activeId }"
          @click="renaming !== c.id && emit('select', c.id)"
        >
          <div class="label-col">
            <input
              v-if="renaming === c.id"
              ref="renameInput"
              v-model="renameVal"
              class="rename-input"
              @blur="confirmRename(c.id)"
              @keydown="onRenameKey($event, c.id)"
              @click.stop
            />
            <span v-else class="label" @dblclick="startRename(c, $event)" :title="'Двойной клик — переименовать'">{{ c.title }}</span>
            <span
              v-if="c.tokensPrompt || c.tokensCompletion"
              class="chat-toks"
            >↑{{ fmtTok(c.tokensPrompt) }} ↓{{ fmtTok(c.tokensCompletion) }}</span>
          </div>
          <span class="badge" v-if="c.contextSns.length" :title="c.contextSns.join(', ')">
            {{ c.contextSns.length }}
          </span>
          <button class="ghost" title="Удалить" @click.stop="emit('delete', c.id)">×</button>
        </div>
      </div>
      <div class="sidebar-footer">
        <div>Каждый чат — отдельная задача со своим контекстом контроллеров</div>
        <div v-if="totalStats && (totalStats.totalPromptTokens || totalStats.totalCompletionTokens)" class="token-total">
          всего: ↑{{ fmtTok(totalStats.totalPromptTokens) }} ↓{{ fmtTok(totalStats.totalCompletionTokens) }}
        </div>
      </div>
    </template>
  </aside>
</template>

<style scoped>
.label-col { display: flex; flex-direction: column; flex: 1; min-width: 0; overflow: hidden; }
.chat-toks { font-size: 10px; color: var(--text-mute); opacity: 0.7; }
.rename-input {
  font: inherit; padding: 0 2px; height: 20px; width: 100%;
  border-radius: 3px; font-size: 13px;
}
.token-total {
  margin-top: 4px;
  font-size: 11px;
  opacity: 0.6;
}
</style>
