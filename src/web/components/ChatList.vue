<script setup lang="ts">
import type { Chat, TokenStats } from '../api'

defineProps<{ chats: Chat[]; activeId: string | null; totalStats: TokenStats | null }>()
const emit = defineEmits<{
  new: []
  select: [id: string]
  delete: [id: string]
}>()

function fmtTok(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}
</script>

<template>
  <aside class="sidebar">
    <div class="sidebar-header">
      <span>Чаты</span>
      <button class="primary" @click="emit('new')" title="Новый чат (Ctrl+N)">+ Новый</button>
    </div>
    <div class="sidebar-body">
      <div v-if="!chats.length" class="empty">Чатов пока нет</div>
      <div
        v-for="c in chats"
        :key="c.id"
        class="chat-list-item"
        :class="{ active: c.id === activeId }"
        @click="emit('select', c.id)"
      >
        <span class="label">{{ c.title }}</span>
        <span class="badge" v-if="c.contextSns.length" :title="c.contextSns.join(', ')">
          {{ c.contextSns.length }}
        </span>
        <button
          class="ghost"
          title="Удалить"
          @click.stop="emit('delete', c.id)"
        >×</button>
      </div>
    </div>
    <div class="sidebar-footer">
      <div>Каждый чат — отдельная задача со своим контекстом контроллеров</div>
      <div v-if="totalStats && (totalStats.totalPromptTokens || totalStats.totalCompletionTokens)" class="token-total">
        всего: ↑{{ fmtTok(totalStats.totalPromptTokens) }} ↓{{ fmtTok(totalStats.totalCompletionTokens) }}
      </div>
    </div>
  </aside>
</template>

<style scoped>
.token-total {
  margin-top: 4px;
  font-size: 11px;
  opacity: 0.6;
}
</style>
