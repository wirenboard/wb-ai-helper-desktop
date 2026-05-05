<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted } from 'vue'
import { marked } from 'marked'
import type { ChatItem, ChatItemToolCall } from '../api'
import { fmtSize } from '../utils'

marked.use({ breaks: true, gfm: true })
function renderMd(text: string): string {
  const html = marked.parse(text) as string
  return html.replace(/<li>\s*<p>([\s\S]*?)<\/p>\s*<\/li>/g, (_, inner) => `<li>${inner.trim()}</li>`)
}

const props = defineProps<{ item: ChatItem; chatId: string }>()
const emit = defineEmits<{ copy: [text: string] }>()

const expanded = ref(false)
const resultExpanded = ref(false)
const copied = ref(false)

const PREVIEW_LINES = 5
const LONG_THRESHOLD = 10

const inputPreview = computed(() => {
  if (props.item.type !== 'tool_call') return ''
  const e = Object.entries(props.item.input)
  if (!e.length) return ''
  return e.map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(', ')
})

const resultContent = computed(() => (props.item.type === 'tool_call' && props.item.result) ? props.item.result.content : '')
const isLongResult = computed(() => resultContent.value.split('\n').length > LONG_THRESHOLD)
const truncatedResult = computed(() => {
  if (!isLongResult.value || resultExpanded.value) return resultContent.value
  return resultContent.value.split('\n').slice(0, PREVIEW_LINES).join('\n')
})

const assistantHtml = computed(() => props.item.type === 'assistant_text' ? renderMd(props.item.text) : '')

async function copyText() {
  if (props.item.type !== 'assistant_text') return
  await navigator.clipboard.writeText(props.item.text)
  copied.value = true
  setTimeout(() => { copied.value = false }, 1500)
}

async function downloadViaFetch(url: string, name: string) {
  const res = await fetch(url)
  const blob = await res.blob()
  const blobUrl = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = blobUrl; a.download = name
  document.body.appendChild(a); a.click()
  document.body.removeChild(a); URL.revokeObjectURL(blobUrl)
}
</script>

<template>
  <!-- User message -->
  <div v-if="item.type === 'user'" class="msg user">
    <div class="bubble">
      {{ item.text }}
    </div>
  </div>

  <!-- Assistant text -->
  <div v-else-if="item.type === 'assistant_text'" class="msg assistant">
    <div class="bubble markdown">
      <div v-html="assistantHtml" />
      <div class="msg-footer">
        <span v-if="item.tokensPrompt || item.tokensCompletion" class="token-meta">
          ↑{{ item.tokensPrompt ?? 0 }} ↓{{ item.tokensCompletion ?? 0 }}
        </span>
        <button class="copy-btn" :title="copied ? 'Скопировано!' : 'Копировать'" @click="copyText">
          {{ copied ? '✓' : '⎘' }}
        </button>
      </div>
    </div>
  </div>

  <!-- Tool call -->
  <div v-else-if="item.type === 'tool_call'" class="msg tool">
    <button class="tool-head" @click="expanded = !expanded">
      <span class="tool-icon">⚙</span>
      <span class="tool-name">{{ item.name }}</span>
      <span v-if="inputPreview" class="tool-args">({{ inputPreview }})</span>
      <span v-if="item.result" class="tool-status" :class="{ err: item.result.isError }">
        {{ item.result.isError ? '✗' : '✓' }}
      </span>
      <span v-else class="tool-status pending">…</span>
      <span class="caret">{{ expanded ? '▾' : '▸' }}</span>
    </button>
    <div v-if="expanded && item.result" class="tool-result-wrap">
      <pre class="tool-result" :class="{ err: item.result.isError, truncated: isLongResult && !resultExpanded }">{{ truncatedResult }}</pre>
      <button v-if="isLongResult" class="result-toggle" @click="resultExpanded = !resultExpanded">
        {{ resultExpanded ? '▲ свернуть' : `▼ показать всё (${resultContent.split('\n').length} строк)` }}
      </button>
    </div>
  </div>

  <!-- File from controller -->
  <div v-else-if="item.type === 'assistant_file'" class="msg assistant">
    <div v-if="item.mime?.startsWith('image/')" class="file-image-wrap">
      <img :src="item.url" :alt="item.name" class="file-image" />
      <a href="#" @click.prevent="downloadViaFetch(item.url, item.name)" class="file-image-dl">Скачать</a>
    </div>
    <a v-else class="file-card" href="#" @click.prevent="downloadViaFetch(item.url, item.name)">
      <span class="file-icon">📎</span>
      <div class="file-meta">
        <div class="file-name">{{ item.name }}</div>
        <div class="file-sub">
          <span>{{ fmtSize(item.size) }}</span>
          <span v-if="item.sourcePath" class="file-src" :title="item.sourcePath">
            · с контроллера{{ item.sourceSn ? ` ${item.sourceSn}` : '' }}
          </span>
        </div>
      </div>
      <span class="file-dl">Скачать</span>
    </a>
  </div>

  <!-- Error -->
  <div v-else-if="item.type === 'error'" class="msg error">
    <div class="bubble">⚠ {{ (item as any).message }}</div>
  </div>
</template>

<style scoped>
.msg { margin: 3px 0; }

/* ── Bubbles ────────────────────────────────────────────────── */
.bubble {
  display: inline-block;
  padding: 8px 12px;
  border-radius: 8px;
  font-size: 0.875rem;
  line-height: 1.45;
  white-space: pre-wrap;
  word-break: break-word;
  max-width: 88%;
  position: relative;
}
.user { display: flex; justify-content: flex-end; }
.user .bubble { background: var(--accent-soft); color: var(--text); border-bottom-right-radius: 2px; max-width: 72%; }
.assistant { width: 100%; }
.assistant .bubble { background: var(--bg-soft); color: var(--text); border-bottom-left-radius: 2px; width: 100%; max-width: 100%; display: block; box-sizing: border-box; }
.error .bubble { background: #fef2f2; color: var(--danger); border: 1px solid #fbb; }

/* ── Markdown ───────────────────────────────────────────────── */
.bubble.markdown { white-space: normal; }
.bubble.markdown :deep(p) { margin: 0 0 0.6em; }
.bubble.markdown :deep(p:last-child) { margin-bottom: 0; }
.bubble.markdown :deep(ul), .bubble.markdown :deep(ol) { margin: 0.4em 0; padding-left: 1.4em; }
.bubble.markdown :deep(li) { margin: 0.15em 0; }
.bubble.markdown :deep(li > p) { margin: 0; }
.bubble.markdown :deep(h1), .bubble.markdown :deep(h2), .bubble.markdown :deep(h3), .bubble.markdown :deep(h4) { margin: 0.8em 0 0.3em; font-weight: 700; }
.bubble.markdown :deep(h1) { font-size: 1.05rem; }
.bubble.markdown :deep(h2) { font-size: 1rem; }
.bubble.markdown :deep(h3), .bubble.markdown :deep(h4) { font-size: 0.95rem; }
.bubble.markdown :deep(a) { color: var(--accent); text-decoration: underline; }
.bubble.markdown :deep(code) { font-family: 'JetBrains Mono', monospace; font-size: 0.8125rem; background: rgba(0,0,0,0.07); padding: 0.1em 0.35em; border-radius: 3px; }
.bubble.markdown :deep(pre) { margin: 0.5em 0; padding: 8px 10px; background: #1e1e1e; color: #e6e6e6; border-radius: 5px; overflow-x: auto; line-height: 1.4; }
.bubble.markdown :deep(pre code) { background: transparent; color: inherit; padding: 0; font-size: 0.78rem; white-space: pre; }
.bubble.markdown :deep(blockquote) { margin: 0.5em 0; padding: 0.1em 0.8em; border-left: 3px solid var(--border); color: var(--text-mute); }
.bubble.markdown :deep(table) { border-collapse: collapse; margin: 0.5em 0; font-size: 0.82rem; }
.bubble.markdown :deep(th), .bubble.markdown :deep(td) { border: 1px solid var(--border); padding: 4px 8px; }
.bubble.markdown :deep(th) { background: var(--bg-mute); }
.bubble.markdown :deep(hr) { border: none; border-top: 1px solid var(--border); margin: 0.7em 0; }
.bubble.markdown :deep(.mermaid) { margin: 0.5em 0; overflow: auto; }
.bubble.markdown :deep(.mermaid svg) { max-width: 100%; height: auto; }

/* ── Message footer (copy + tokens) ────────────────────────── */
.msg-footer { display: flex; align-items: center; justify-content: space-between; margin-top: 6px; }
.token-meta { font-size: 0.6875rem; color: var(--text-mute); opacity: 0.7; font-family: 'JetBrains Mono', monospace; }
.copy-btn {
  border: none; background: transparent; color: var(--text-mute); cursor: pointer;
  font-size: 0.75rem; padding: 0 4px; opacity: 0; transition: opacity 0.15s;
}
.assistant:hover .copy-btn { opacity: 1; }
.copy-btn:hover { color: var(--text); }

/* ── Tool call ──────────────────────────────────────────────── */
.tool { font-size: 0.75rem; }
.tool-head {
  display: flex; align-items: center; gap: 6px; width: 100%;
  border: 1px dashed var(--border); background: var(--bg);
  border-radius: 4px; padding: 4px 8px;
  font-family: 'JetBrains Mono', monospace; font-size: 0.6875rem;
  cursor: pointer; color: var(--text-mute); text-align: left;
}
.tool-head:hover { background: var(--bg-soft); }
.tool-icon { color: var(--ok); }
.tool-name { font-weight: 700; color: var(--text); }
.tool-args { color: var(--text-mute); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }
.tool-status { font-weight: 700; color: var(--ok); }
.tool-status.err { color: var(--danger); }
.tool-status.pending { color: var(--text-mute); }
.caret { margin-left: 2px; color: var(--text-mute); }
.tool-result-wrap { margin: 4px 0 0; }
.tool-result {
  margin: 0; padding: 8px; background: var(--bg-soft); border: 1px solid var(--border);
  border-radius: 4px; font-family: 'JetBrains Mono', monospace; font-size: 0.6875rem;
  line-height: 1.4; white-space: pre-wrap; word-break: break-word; max-height: 400px; overflow: auto;
}
.tool-result.truncated { max-height: none; overflow: hidden; border-bottom-left-radius: 0; border-bottom-right-radius: 0; border-bottom: none; }
.tool-result.err { background: #fff5f5; border-color: #fbb; color: #b00; }
.result-toggle {
  display: block; width: 100%; padding: 3px 8px;
  background: var(--bg-mute); border: 1px solid var(--border); border-top: none;
  border-radius: 0 0 4px 4px; font-family: 'JetBrains Mono', monospace;
  font-size: 0.625rem; color: var(--text-mute); cursor: pointer; text-align: center;
}
.result-toggle:hover { background: var(--bg-soft); color: var(--text); }

/* ── File card ──────────────────────────────────────────────── */
.file-card {
  display: inline-flex; align-items: center; gap: 10px; max-width: 100%;
  padding: 8px 10px; background: var(--bg); border: 1px solid var(--border);
  border-radius: 6px; text-decoration: none; color: var(--text); font-size: 0.8125rem;
  box-shadow: 0 1px 2px rgba(0,0,0,0.04);
}
.file-card:hover { border-color: var(--accent); background: var(--bg-soft); }
.file-icon { font-size: 1.125rem; flex: none; }
.file-meta { min-width: 0; flex: 1; }
.file-name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.file-sub { display: flex; gap: 6px; font-size: 0.6875rem; color: var(--text-mute); font-family: 'JetBrains Mono', monospace; }
.file-src { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.file-dl { flex: none; padding: 3px 10px; background: var(--accent); color: #fff; border-radius: 4px; font-size: 0.75rem; font-weight: 600; }
.file-image-wrap { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; }
.file-image { max-width: 100%; border-radius: 6px; border: 1px solid var(--border); display: block; }
.file-image-dl { font-size: 0.75rem; color: var(--accent); text-decoration: none; }
.file-image-dl:hover { text-decoration: underline; }
</style>
