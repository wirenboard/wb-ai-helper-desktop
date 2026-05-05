<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch, nextTick } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'

const props = defineProps<{ sn: string | null }>()
const emit = defineEmits<{ close: [] }>()

const containerEl = ref<HTMLElement | null>(null)
const heightPx = ref(380)
const status = ref<'connecting' | 'ready' | 'error' | 'closed'>('connecting')
const errorMsg = ref('')

let term: Terminal | null = null
let fit: FitAddon | null = null
let ws: WebSocket | null = null
let resizeObserver: ResizeObserver | null = null

function open(sn: string) {
  if (!containerEl.value) return
  status.value = 'connecting'
  errorMsg.value = ''

  term = new Terminal({
    cursorBlink: true,
    fontFamily: '"JetBrains Mono", Menlo, Consolas, monospace',
    fontSize: 13,
    theme: { background: '#0f172a', foreground: '#e2e8f0', cursor: '#60a5fa' },
    convertEol: false,
    scrollback: 5000,
  })
  fit = new FitAddon()
  term.loadAddon(fit)
  term.loadAddon(new WebLinksAddon())
  term.open(containerEl.value)
  fit.fit()
  term.focus()

  const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/ssh/${encodeURIComponent(sn)}/shell`
  ws = new WebSocket(wsUrl)
  ws.onopen = () => {
    if (!term) return
    const dim = term.cols && term.rows ? { cols: term.cols, rows: term.rows } : { cols: 80, rows: 24 }
    ws!.send(JSON.stringify({ t: 'init', sn, ...dim }))
  }
  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data)
      if (msg.t === 'data' && term) term.write(msg.d)
      else if (msg.t === 'ready') status.value = 'ready'
      else if (msg.t === 'error') { status.value = 'error'; errorMsg.value = msg.e ?? 'unknown error' }
      else if (msg.t === 'close') status.value = 'closed'
    } catch { /* ignore */ }
  }
  ws.onerror = () => { if (status.value === 'connecting') { status.value = 'error'; errorMsg.value = 'WebSocket error' } }
  ws.onclose = () => { if (status.value !== 'error') status.value = 'closed' }

  term.onData((d) => { ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ t: 'data', d })) })
  term.onResize(({ cols, rows }) => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'resize', cols, rows }))
  })

  resizeObserver = new ResizeObserver(() => fit?.fit())
  resizeObserver.observe(containerEl.value)
}

function destroy() {
  resizeObserver?.disconnect(); resizeObserver = null
  ws?.close(); ws = null
  term?.dispose(); term = null
  fit = null
}

onMounted(() => { if (props.sn) open(props.sn) })
onBeforeUnmount(destroy)
watch(() => props.sn, async (n) => {
  destroy()
  if (n) { await nextTick(); open(n) }
})

// Vertical resize from the top edge
let dragging = false
let dragStartY = 0
let dragStartH = 0
function startResize(e: MouseEvent) {
  dragging = true; dragStartY = e.clientY; dragStartH = heightPx.value
  e.preventDefault()
}
function onMove(e: MouseEvent) {
  if (!dragging) return
  const dy = dragStartY - e.clientY
  heightPx.value = Math.max(160, Math.min(window.innerHeight - 100, dragStartH + dy))
}
function onUp() { dragging = false }
window.addEventListener('mousemove', onMove)
window.addEventListener('mouseup', onUp)
onBeforeUnmount(() => {
  window.removeEventListener('mousemove', onMove)
  window.removeEventListener('mouseup', onUp)
})
</script>

<template>
  <div v-if="sn" class="ssh-sheet" :style="{ height: heightPx + 'px' }">
    <div class="ssh-resize" @mousedown="startResize" />
    <div class="ssh-header">
      <span class="ssh-icon">▷_</span>
      <span class="ssh-title">SSH: {{ sn }}</span>
      <span class="ssh-status" :class="status">
        {{ status === 'connecting' ? 'подключение…'
          : status === 'ready' ? 'онлайн'
          : status === 'closed' ? 'закрыт'
          : 'ошибка' }}
      </span>
      <button class="ssh-close" @click="emit('close')" title="Закрыть">×</button>
    </div>
    <div ref="containerEl" class="ssh-body" />
    <div v-if="status === 'error'" class="ssh-error">⚠ {{ errorMsg }}</div>
  </div>
</template>

<style scoped>
.ssh-sheet {
  position: fixed; left: 0; right: 0; bottom: 0;
  background: #0f172a;
  display: flex; flex-direction: column;
  z-index: 50;
  box-shadow: 0 -4px 16px rgba(0,0,0,0.3);
}
.ssh-resize {
  height: 4px; background: var(--border); cursor: ns-resize;
  flex: none;
}
.ssh-resize:hover { background: var(--accent); }
.ssh-header {
  display: flex; align-items: center; gap: 10px;
  padding: 6px 12px;
  background: #1e293b; color: #cbd5e1;
  font-size: 0.8rem; flex: none;
}
.ssh-icon { color: #60a5fa; font-family: 'JetBrains Mono', monospace; }
.ssh-title { font-weight: 600; }
.ssh-status { margin-left: auto; font-size: 0.7rem; opacity: 0.7; }
.ssh-status.ready { color: #4ade80; }
.ssh-status.error, .ssh-status.closed { color: #f87171; }
.ssh-close {
  background: transparent; border: none; color: #cbd5e1;
  font-size: 1.1rem; cursor: pointer; padding: 0 6px; line-height: 1;
}
.ssh-close:hover { color: #f87171; }
.ssh-body { flex: 1; overflow: hidden; padding: 6px 8px; min-height: 0; }
.ssh-body :deep(.xterm) { height: 100%; }
.ssh-body :deep(.xterm-viewport) { background: transparent !important; }
.ssh-error {
  flex: none; padding: 6px 12px; background: #7f1d1d; color: #fee2e2; font-size: 0.78rem;
}
</style>
