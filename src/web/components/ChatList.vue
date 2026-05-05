<script setup lang="ts">
import type { Chat } from '../api'

defineProps<{ chats: Chat[]; activeId: string | null }>()
const emit = defineEmits<{
  new: []
  select: [id: string]
  delete: [id: string]
}>()
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
      Каждый чат — отдельная задача со своим контекстом контроллеров
    </div>
  </aside>
</template>
