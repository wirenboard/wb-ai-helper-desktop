<script setup lang="ts">
import { ref } from 'vue'
import type { Controller } from '../api'

defineProps<{ controllers: Controller[]; selected: string[]; open: boolean; scanning?: boolean }>()
const emit = defineEmits<{
  'toggle-panel': []
  rescan: []
  'add-manual': [host: string]
  remove: [sn: string]
  toggle: [sn: string]
  'select-all': []
  clear: []
  'open-terminal': [sn: string]
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
        <button @click="emit('rescan')" :disabled="scanning" :title="scanning ? 'Сканирование…' : 'Пересканировать сеть'" :style="scanning ? 'animation: spin 1s linear infinite' : ''">↻</button>
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
          <div class="host" :title="c.port ? `${c.host} (SSH порт ${c.port})` : c.host">
            {{ c.host }}<span v-if="c.port && c.port !== 22" class="port-suffix">:{{ c.port }}</span>
          </div>
          <div class="row" style="justify-content:space-between;margin-top:2px">
            <span class="status" :class="statusOf(c).cls">{{ statusOf(c).text }}</span>
            <span class="small muted">{{ c.source === 'manual' ? 'вручную' : 'mDNS' }}</span>
          </div>
          <div class="actions" @click.stop>
            <a
              class="icon-action"
              :href="`http://${c.host}/`"
              target="_blank"
              rel="noopener"
              title="Web UI"
              aria-label="Web UI"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>
            </a>
            <button
              class="icon-action"
              title="SSH-терминал"
              aria-label="SSH-терминал"
              @click="emit('open-terminal', c.sn)"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
            </button>
            <button
              v-if="c.source === 'manual'"
              class="icon-action danger"
              title="Удалить из списка"
              aria-label="Удалить"
              @click="emit('remove', c.sn)"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="6" y1="18" x2="18" y2="6"/></svg>
            </button>
          </div>
        </div>
      </div>
    </div>
    <div class="sidebar-footer">
      <div class="spread">
        <input
          v-model="manualHost"
          placeholder="hostname / IP[:ssh-порт]"
          title="Примеры: wirenboard-abc.local · 192.168.1.10 · 192.168.1.10:2222"
          @keydown.enter="add"
        />
        <button @click="add">+</button>
      </div>
    </div>
    </template>
  </aside>
</template>

<style scoped>
.port-suffix { color: var(--text-mute); }
.actions { display: flex; gap: 4px; margin-top: 6px; justify-content: flex-end; }
.icon-action {
  display: inline-flex; align-items: center; justify-content: center;
  width: 22px; height: 22px; padding: 0;
  background: transparent; border: 1px solid var(--border); border-radius: 4px;
  color: var(--text-mute); cursor: pointer; text-decoration: none;
}
.icon-action:hover { background: var(--bg-soft); color: var(--accent); border-color: var(--accent); }
.icon-action.danger:hover { color: var(--danger); border-color: var(--danger); }
.icon-action svg { display: block; }
</style>
