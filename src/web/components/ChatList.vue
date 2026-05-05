<script setup lang="ts">
import type { Chat, TokenStats } from '../api'
import { fmtTok } from '../utils'

defineProps<{ chats: Chat[]; activeId: string | null; totalStats: TokenStats | null; open: boolean }>()
const emit = defineEmits<{
  new: []
  select: [id: string]
  delete: [id: string]
  toggle: []
}>()

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
          @click="emit('select', c.id)"
        >
          <span class="label">{{ c.title }}</span>
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
.token-total {
  margin-top: 4px;
  font-size: 11px;
  opacity: 0.6;
}
</style>
