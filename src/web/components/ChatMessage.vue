<script setup lang="ts">
import { computed, ref, watch, nextTick, onMounted } from 'vue'
import { marked } from 'marked'
import mermaid from 'mermaid'
import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import json from 'highlight.js/lib/languages/json'
import python from 'highlight.js/lib/languages/python'
import javascript from 'highlight.js/lib/languages/javascript'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import sql from 'highlight.js/lib/languages/sql'
import yaml from 'highlight.js/lib/languages/yaml'
import ini from 'highlight.js/lib/languages/ini'
import type { ChatItem, ChatItemToolCall } from '../api'
import { fmtSize } from '../utils'

hljs.registerLanguage('bash', bash); hljs.registerLanguage('sh', bash)
hljs.registerLanguage('json', json)
hljs.registerLanguage('python', python); hljs.registerLanguage('py', python)
hljs.registerLanguage('javascript', javascript); hljs.registerLanguage('js', javascript)
hljs.registerLanguage('typescript', typescript); hljs.registerLanguage('ts', typescript)
hljs.registerLanguage('xml', xml); hljs.registerLanguage('html', xml)
hljs.registerLanguage('sql', sql)
hljs.registerLanguage('yaml', yaml); hljs.registerLanguage('yml', yaml)
hljs.registerLanguage('ini', ini); hljs.registerLanguage('toml', ini)

mermaid.initialize({ startOnLoad: false })

marked.use({ breaks: true, gfm: true })
marked.use({
  renderer: {
    code({ text, lang }) {
      if (lang === 'mermaid') return `<div class="mermaid">${text}</div>`
      const validLang = lang && hljs.getLanguage(lang) ? lang : undefined
      const highlighted = validLang
        ? hljs.highlight(text, { language: validLang }).value
        : hljs.highlightAuto(text).value
      const langClass = validLang ? ` language-${validLang}` : ''
      return `<pre><code class="hljs${langClass}">${highlighted}</code></pre>`
    }
  }
})

function renderMd(text: string): string {
  const html = marked.parse(text) as string
  return html.replace(/<li>\s*<p>([\s\S]*?)<\/p>\s*<\/li>/g, (_, inner) => `<li>${inner.trim()}</li>`)
}

const props = defineProps<{ item: ChatItem; chatId: string }>()

const expanded = ref(false)
const resultExpanded = ref(false)
const copied = ref(false)
const userCopied = ref(false)
const resultCopied = ref(false)
const bubbleEl = ref<HTMLElement | null>(null)

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

async function runMermaid() {
  await nextTick()
  if (!bubbleEl.value) return
  const nodes = Array.from(bubbleEl.value.querySelectorAll<HTMLElement>('.mermaid:not([data-processed="true"])'))
  if (nodes.length) await mermaid.run({ nodes, suppressErrors: true })
}

watch(assistantHtml, runMermaid, { flush: 'post' })
onMounted(runMermaid)

async function copyText() {
  if (props.item.type !== 'assistant_text') return
  await navigator.clipboard.writeText(props.item.text)
  copied.value = true
  setTimeout(() => { copied.value = false }, 1500)
}

async function copyUser() {
  if (props.item.type !== 'user') return
  await navigator.clipboard.writeText(props.item.text)
  userCopied.value = true
  setTimeout(() => { userCopied.value = false }, 1500)
}

async function copyResult() {
  await navigator.clipboard.writeText(resultContent.value)
  resultCopied.value = true
  setTimeout(() => { resultCopied.value = false }, 1500)
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
    <div class="bubble user-bubble">
      {{ item.text }}
      <button class="copy-btn user-copy" :title="userCopied ? 'Скопировано!' : 'Копировать'" @click="copyUser">
        {{ userCopied ? '✓' : '⎘' }}
      </button>
    </div>
  </div>

  <!-- Assistant text -->
  <div v-else-if="item.type === 'assistant_text'" class="msg assistant">
    <div class="bubble markdown">
      <button class="copy-btn" :title="copied ? 'Скопировано!' : 'Копировать'" @click="copyText">
        {{ copied ? '✓' : '⎘' }}
      </button>
      <div ref="bubbleEl" v-html="assistantHtml" />
      <div v-if="item.tokensPrompt || item.tokensCompletion" class="msg-footer">
        <span class="token-meta">↑{{ item.tokensPrompt ?? 0 }} ↓{{ item.tokensCompletion ?? 0 }}<template v-if="item.tokensCached"> ⊙{{ item.tokensCached }}</template></span>
      </div>
    </div>
  </div>

  <!-- Tool call -->
  <div v-else-if="item.type === 'tool_call'" class="msg tool">
    <button class="tool-head" @click="expanded = !expanded">
      <span class="tool-dot" :class="item.result ? (item.result.isError ? 'err' : 'ok') : 'pending'"></span>
      <span class="tool-name">{{ item.name }}</span>
      <span v-if="inputPreview" class="tool-args">({{ inputPreview }})</span>
      <span class="caret">{{ expanded ? '▾' : '▸' }}</span>
    </button>
    <div v-if="expanded && item.result" class="tool-result-wrap">
      <div class="tool-result-actions">
        <button class="result-copy-btn" :title="resultCopied ? 'Скопировано!' : 'Копировать'" @click="copyResult">
          {{ resultCopied ? '✓ скопировано' : '⎘ копировать' }}
        </button>
      </div>
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

  <!-- System event (auto job-done notification) -->
  <div v-else-if="item.type === 'system_event'" class="msg system-event">
    <span class="system-event-icon">⚙</span>
    <span class="system-event-text">{{ (item as any).text }}</span>
  </div>
</template>

<style scoped>
.msg { margin: 4px 0; }

/* ── System event ───────────────────────────────────────────── */
.system-event {
  display: flex; align-items: center; gap: 6px;
  padding: 4px 8px; margin: 2px 0;
  font-size: 0.75rem; color: var(--text-mute);
  border-left: 2px solid var(--border);
}
.system-event-icon { opacity: 0.5; flex-shrink: 0; }
.system-event-text { font-style: italic; }

/* ── User bubble ────────────────────────────────────────────── */
.user { display: flex; justify-content: flex-end; }
.user-bubble {
  background: var(--accent-soft); color: var(--text);
  border-bottom-right-radius: 2px;
  max-width: 72%; display: inline-block;
  padding: 10px 14px; border-radius: 10px;
  font-size: 1rem; line-height: 1.5;
  word-break: break-word; white-space: pre-wrap;
  position: relative;
}
.user:hover .user-copy { opacity: 1; }

/* ── Assistant bubble ───────────────────────────────────────── */
.bubble {
  display: block;
  padding: 10px 14px;
  border-radius: 10px;
  font-size: 1rem;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  position: relative;
}
.assistant { width: 100%; }
.assistant .bubble { background: var(--bg-soft); color: var(--text); border-bottom-left-radius: 2px; box-sizing: border-box; }
.error .bubble { background: #fef2f2; color: var(--danger); border: 1px solid #fbb; }

/* ── Markdown ───────────────────────────────────────────────── */
.bubble.markdown { white-space: normal; }
.bubble.markdown :deep(p) { margin: 0 0 0.6em; }
.bubble.markdown :deep(p:last-child) { margin-bottom: 0; }
.bubble.markdown :deep(ul), .bubble.markdown :deep(ol) { margin: 0.4em 0; padding-left: 1.4em; }
.bubble.markdown :deep(li) { margin: 0.15em 0; }
.bubble.markdown :deep(li > p) { margin: 0; }
.bubble.markdown :deep(h1), .bubble.markdown :deep(h2), .bubble.markdown :deep(h3), .bubble.markdown :deep(h4) { margin: 0.8em 0 0.3em; font-weight: 700; }
.bubble.markdown :deep(h1) { font-size: 1.1rem; }
.bubble.markdown :deep(h2) { font-size: 1.05rem; }
.bubble.markdown :deep(h3), .bubble.markdown :deep(h4) { font-size: 1rem; }
.bubble.markdown :deep(a) { color: var(--accent); text-decoration: underline; }
.bubble.markdown :deep(code) { font-family: 'JetBrains Mono', monospace; font-size: 0.85rem; background: rgba(0,0,0,0.07); padding: 0.1em 0.35em; border-radius: 3px; }
.bubble.markdown :deep(pre) { margin: 0.5em 0; padding: 10px 12px; background: #1e1e1e; color: #e6e6e6; border-radius: 6px; overflow-x: auto; line-height: 1.5; }
.bubble.markdown :deep(pre code) { background: transparent; color: inherit; padding: 0; font-size: 0.82rem; white-space: pre; }
.bubble.markdown :deep(blockquote) { margin: 0.5em 0; padding: 0.1em 0.8em; border-left: 3px solid var(--border); color: var(--text-mute); }
.bubble.markdown :deep(table) { border-collapse: collapse; margin: 0.5em 0; font-size: 0.9rem; }
.bubble.markdown :deep(th), .bubble.markdown :deep(td) { border: 1px solid var(--border); padding: 5px 10px; }
.bubble.markdown :deep(th) { background: var(--bg-mute); }
.bubble.markdown :deep(hr) { border: none; border-top: 1px solid var(--border); margin: 0.7em 0; }
.bubble.markdown :deep(.mermaid) { margin: 0.5em 0; overflow: auto; display: flex; justify-content: center; }
.bubble.markdown :deep(.mermaid svg) { max-width: 100%; height: auto; }

/* Syntax highlighting (VS Code dark theme tokens) */
.bubble.markdown :deep(.hljs-keyword), .bubble.markdown :deep(.hljs-built_in) { color: #569cd6; }
.bubble.markdown :deep(.hljs-string), .bubble.markdown :deep(.hljs-template-string) { color: #ce9178; }
.bubble.markdown :deep(.hljs-number) { color: #b5cea8; }
.bubble.markdown :deep(.hljs-comment) { color: #6a9955; font-style: italic; }
.bubble.markdown :deep(.hljs-function), .bubble.markdown :deep(.hljs-title) { color: #dcdcaa; }
.bubble.markdown :deep(.hljs-variable), .bubble.markdown :deep(.hljs-params) { color: #9cdcfe; }
.bubble.markdown :deep(.hljs-attr), .bubble.markdown :deep(.hljs-attribute) { color: #9cdcfe; }
.bubble.markdown :deep(.hljs-class), .bubble.markdown :deep(.hljs-type) { color: #4ec9b0; }
.bubble.markdown :deep(.hljs-literal), .bubble.markdown :deep(.hljs-boolean) { color: #569cd6; }
.bubble.markdown :deep(.hljs-tag) { color: #808080; }
.bubble.markdown :deep(.hljs-name) { color: #569cd6; }
.bubble.markdown :deep(.hljs-selector-tag) { color: #d7ba7d; }
.bubble.markdown :deep(.hljs-meta) { color: #9cdcfe; }
.bubble.markdown :deep(.hljs-punctuation), .bubble.markdown :deep(.hljs-operator) { color: #d4d4d4; }
.bubble.markdown :deep(.hljs-property) { color: #9cdcfe; }

/* ── Message footer (tokens) ────────────────────────────────── */
.msg-footer { display: flex; align-items: center; margin-top: 6px; }
.token-meta { font-size: 0.7rem; color: var(--text-mute); opacity: 0.7; font-family: 'JetBrains Mono', monospace; }

/* ── Copy buttons ───────────────────────────────────────────── */
.copy-btn {
  position: absolute; top: 8px; right: 10px;
  border: none; background: transparent; color: var(--text-mute); cursor: pointer;
  font-size: 0.8rem; padding: 0 2px; opacity: 0; transition: opacity 0.15s;
}
.assistant:hover .copy-btn { opacity: 1; }
.copy-btn:hover { color: var(--text); }
.user-copy {
  position: absolute; top: 6px; right: 8px;
  border: none; background: transparent; color: var(--text-mute); cursor: pointer;
  font-size: 0.8rem; padding: 0 2px; opacity: 0; transition: opacity 0.15s;
}
.user-copy:hover { color: var(--text); }

/* ── Tool call ──────────────────────────────────────────────── */
.tool { font-size: 0.85rem; }
.tool-head {
  display: flex; align-items: center; gap: 8px; width: 100%;
  border: 1px dashed var(--border); background: var(--bg);
  border-radius: 5px; padding: 5px 10px;
  font-family: 'JetBrains Mono', monospace; font-size: 0.78rem;
  cursor: pointer; color: var(--text-mute); text-align: left;
}
.tool-head:hover { background: var(--bg-soft); }

/* Status dot */
.tool-dot {
  width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
}
.tool-dot.ok { background: var(--ok); }
.tool-dot.err { background: var(--danger); }
.tool-dot.pending { background: var(--warn); animation: dot-pulse 1s ease-in-out infinite; }
@keyframes dot-pulse { 0%, 100% { opacity: 0.4; transform: scale(0.85); } 50% { opacity: 1; transform: scale(1.15); } }

.tool-name { font-weight: 700; color: var(--text); }
.tool-args { color: var(--text-mute); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }
.caret { margin-left: 2px; color: var(--text-mute); flex-shrink: 0; }

/* Tool result */
.tool-result-wrap { margin: 4px 0 0; position: relative; }
.tool-result-actions { display: flex; justify-content: flex-end; padding: 2px 4px; }
.result-copy-btn {
  background: transparent; border: none; color: var(--text-mute); cursor: pointer;
  font-size: 0.7rem; font-family: 'JetBrains Mono', monospace; padding: 2px 6px;
  opacity: 0.6; transition: opacity 0.15s;
}
.tool-result-wrap:hover .result-copy-btn { opacity: 1; }
.result-copy-btn:hover { color: var(--accent); background: none; }
.tool-result {
  margin: 0; padding: 8px 10px; background: var(--bg-soft); border: 1px solid var(--border);
  border-radius: 5px; font-family: 'JetBrains Mono', monospace; font-size: 0.75rem;
  line-height: 1.5; white-space: pre-wrap; word-break: break-word; max-height: 400px; overflow: auto;
}
.tool-result.truncated { max-height: none; overflow: hidden; border-bottom-left-radius: 0; border-bottom-right-radius: 0; border-bottom: none; }
.tool-result.err { background: #fff5f5; border-color: #fbb; color: #b00; }
.result-toggle {
  display: block; width: 100%; padding: 3px 8px;
  background: var(--bg-mute); border: 1px solid var(--border); border-top: none;
  border-radius: 0 0 5px 5px; font-family: 'JetBrains Mono', monospace;
  font-size: 0.7rem; color: var(--text-mute); cursor: pointer; text-align: center;
}
.result-toggle:hover { background: var(--bg-soft); color: var(--text); }

/* ── File card ──────────────────────────────────────────────── */
.file-card {
  display: inline-flex; align-items: center; gap: 10px; max-width: 100%;
  padding: 10px 12px; background: var(--bg); border: 1px solid var(--border);
  border-radius: 8px; text-decoration: none; color: var(--text); font-size: 0.9rem;
  box-shadow: 0 1px 2px rgba(0,0,0,0.04);
}
.file-card:hover { border-color: var(--accent); background: var(--bg-soft); }
.file-icon { font-size: 1.25rem; flex: none; }
.file-meta { min-width: 0; flex: 1; }
.file-name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.file-sub { display: flex; gap: 6px; font-size: 0.75rem; color: var(--text-mute); font-family: 'JetBrains Mono', monospace; }
.file-src { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.file-dl { flex: none; padding: 4px 12px; background: var(--accent); color: #fff; border-radius: 5px; font-size: 0.8rem; font-weight: 600; }
.file-image-wrap { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; }
.file-image { max-width: 100%; border-radius: 6px; border: 1px solid var(--border); display: block; }
.file-image-dl { font-size: 0.8rem; color: var(--accent); text-decoration: none; }
.file-image-dl:hover { text-decoration: underline; }
</style>
