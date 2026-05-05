<script setup lang="ts">
import { ref } from 'vue'
import type { Controller } from '../api'

defineProps<{ controllers: Controller[]; selected: string[]; open: boolean }>()
const emit = defineEmits<{
  'toggle-panel': []
  rescan: []
  'add-manual': [host: string]
  remove: [sn: string]
  toggle: [sn: string]
  'select-all': []
  clear: []
}>()

const manualHost = ref('')

function statusOf(c: Controller): { cls: string; text: string } {
  if (c.reachable === true) return { cls: 'ok', text: 'онлайн' }
  if (c.reachable === false) return { cls: 'bad', text: 'не отвечает' }
  return { cls: 'unknown', text: '—' }
}

function add() {
  const v = manualHost.value.trim()
  if (!v) return
  emit('add-manual', v)
  manualHost.value = ''
}
</script>

<template>
  <aside class="sidebar right" :class="{ collapsed: !open }">
    <div class="sidebar-header">
      <button class="ghost collapse-btn" :title="open ? 'Свернуть' : 'Развернуть'" @click="emit('toggle-panel')">
        {{ open ? '›' : '‹' }}
      </button>
      <template v-if="open">
        <span>Контроллеры</span>
        <button @click="emit('rescan')" title="Пересканировать сеть">↻</button>
      </template>
    </div>
    <template v-if="open">
    <div class="sidebar-body">
      <div v-if="!controllers.length" class="empty">
        Никого не нашли. Контроллер должен быть в той же сети и публиковать
        <span class="kbd">wirenboard-SN.local</span> через mDNS.
      </div>

      <div v-else class="row" style="margin-bottom:8px;justify-content:space-between">
        <span class="small muted">{{ controllers.length }} в сети</span>
        <span class="row">
          <button class="small" @click="emit('select-all')">все</button>
          <button class="small" @click="emit('clear')">сбросить</button>
        </span>
      </div>

      <div
        v-for="c in controllers"
        :key="c.sn"
        class="ctrl-card"
        :class="{ selected: selected.includes(c.sn) }"
        @click="emit('toggle', c.sn)"
      >
        <input
          type="checkbox"
          style="width:auto;margin-top:3px"
          :checked="selected.includes(c.sn)"
          @click.stop
          @change="emit('toggle', c.sn)"
        />
        <div class="meta">
          <div class="sn">{{ c.sn }}</div>
          <div class="host" :title="c.host">{{ c.host }}</div>
          <div class="row" style="justify-content:space-between;margin-top:2px">
            <span class="status" :class="statusOf(c).cls">{{ statusOf(c).text }}</span>
            <span class="small muted">{{ c.source === 'manual' ? 'вручную' : 'mDNS' }}</span>
          </div>
          <div class="row" style="margin-top:4px;gap:4px">
            <a
              class="small"
              :href="`http://${c.host}/`"
              target="_blank"
              rel="noopener"
              @click.stop
            >Web UI ↗</a>
            <button
              v-if="c.source === 'manual'"
              class="ghost small danger"
              @click.stop="emit('remove', c.sn)"
            >удалить</button>
          </div>
        </div>
      </div>
    </div>
    <div class="sidebar-footer">
      <div class="spread">
        <input
          v-model="manualHost"
          placeholder="hostname / IP вручную"
          @keydown.enter="add"
        />
        <button @click="add">+</button>
      </div>
    </div>
    </template>
  </aside>
</template>
