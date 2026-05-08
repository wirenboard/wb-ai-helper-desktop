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
import type { ChatItem, ChatItemToolCall, Settings } from '../api'
import { api, calcCost, PROVIDER_INFO } from '../api'
import { fmtCost, fmtSize, fmtTime, plural } from '../utils'

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

const props = defineProps<{ item: ChatItem; chatId: string; settings?: Settings | null }>()

// Provider/model в подвале — приоритет данные сохранённые на сам turn
// (`item.provider`/`item.model`). Падаем на текущие settings только для
// легаси-турнов, у которых атрибуции в БД ещё нет (миграция v0.13.8 заводит
// колонки provider/model, но старые записи остаются с NULL). Без этого после
// переключения провайдера прошлые сообщения переезжали на новый ярлык/валюту.
const turnProvider = computed(() =>
  (props.item.type === 'assistant_text' && props.item.provider)
    ? props.item.provider
    : (props.settings?.provider ?? null),
)
const turnModel = computed(() =>
  (props.item.type === 'assistant_text' && props.item.model)
    ? props.item.model
    : (props.settings?.model ?? ''),
)
const providerLabel = computed(() => turnProvider.value ? PROVIDER_INFO[turnProvider.value].label : '')

const messageCost = computed(() => {
  if (props.item.type !== 'assistant_text') return null
  const i = props.item
  const p = i.tokensPrompt ?? 0
  const c = i.tokensCompletion ?? 0
  const k = i.tokensCached ?? 0
  if (!p && !c && !i.tokensCost) return null
  // Цена и валюта тоже идут от turn-провайдера, иначе RUB-историю мы бы
  // отрендерили в долларах (или наоборот) после смены активного провайдера.
  const provider = turnProvider.value ?? undefined
  return calcCost(p, c, k, {
    provider,
    tokensCost: i.tokensCost,
    priceInput: props.settings?.priceInput,
    priceOutput: props.settings?.priceOutput,
    priceCached: props.settings?.priceCached,
  })
})

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

const deletedAttachments = ref<Set<string>>(new Set())

async function deleteFileFromChat(attachmentId: string) {
  await api.deleteAttachment(props.chatId, attachmentId).catch(() => {})
  deletedAttachments.value = new Set([...deletedAttachments.value, attachmentId])
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
    <div v-if="item.attachments?.length" class="user-attachments">
      <template v-for="a in item.attachments" :key="a.id">
        <!-- image — thumbnail с открытием в новой вкладке -->
        <div
          v-if="a.isImage && !deletedAttachments.has(a.id)"
          class="user-attach-img"
          :title="`${a.name} · ${a.id}`"
        >
          <a :href="`/api/attachments/${a.id}?chatId=${chatId}`" target="_blank" rel="noopener noreferrer">
            <img :src="`/api/attachments/${a.id}?chatId=${chatId}`" :alt="a.name" />
          </a>
          <button
            class="user-attach-del"
            title="Удалить файл из чата"
            @click="deleteFileFromChat(a.id)"
          >×</button>
          <div class="user-attach-meta">
            <span class="user-attach-name">{{ a.name }}</span>
            <code class="user-attach-id">{{ a.id }}</code>
          </div>
        </div>
        <!-- non-image — chip -->
        <div
          v-else-if="!deletedAttachments.has(a.id)"
          class="user-attach-chip"
          :title="`${a.name} · ${a.id}`"
        >
          <a :href="`/api/attachments/${a.id}?chatId=${chatId}`" target="_blank" rel="noopener noreferrer" class="user-attach-link">
            <span class="user-attach-icon">📎</span>
            <span class="user-attach-name">{{ a.name }}</span>
            <code class="user-attach-id">{{ a.id }}</code>
          </a>
          <button
            class="user-attach-del"
            title="Удалить файл из чата"
            @click="deleteFileFromChat(a.id)"
          >×</button>
        </div>
        <div v-else class="user-attach-deleted">
          📎 {{ a.name }} <code class="user-attach-id">{{ a.id }}</code> — удалено
        </div>
      </template>
    </div>
    <div v-if="item.text" class="bubble user-bubble">
      {{ item.text }}
      <button
        class="user-copy"
        :title="userCopied ? 'Скопировано!' : 'Копировать'"
        @click="copyUser"
      >{{ userCopied ? '✓' : '⎘' }}</button>
    </div>
  </div>

  <!-- Assistant text -->
  <div v-else-if="item.type === 'assistant_text'" class="msg assistant">
    <div class="bubble markdown">
      <button
        class="copy-btn"
        :title="copied ? 'Скопировано!' : 'Копировать'"
        @click="copyText"
      >{{ copied ? '✓' : '⎘' }}</button>
      <div ref="bubbleEl" v-html="assistantHtml" />
      <div v-if="item.tokensPrompt || item.tokensCompletion || item.tokensCost || item.createdAt || turnModel" class="msg-footer">
        <span v-if="turnProvider || turnModel" class="footer-provider">
          <template v-if="turnProvider">{{ providerLabel }}</template><template v-if="turnModel"> · {{ turnModel }}</template>
        </span>
        <span
          class="footer-tokens"
          v-if="item.tokensPrompt || item.tokensCompletion || messageCost || item.toolCallsCount"
        ><template v-if="item.toolCallsCount"
          ><span :title="`В стоимость рядом входит ${item.toolCallsCount} ${plural(item.toolCallsCount, ['LLM-вызов с инструментом', 'LLM-вызова с инструментами', 'LLM-вызовов с инструментами'])} в этом ответе — каждый итерационный вызов биллится отдельно.`">🔧 {{ item.toolCallsCount }}</span> · </template
        >↑{{ item.tokensPrompt ?? 0 }} ↓{{ item.tokensCompletion ?? 0 }}<template v-if="item.tokensCached"> ⊙{{ item.tokensCached }}</template><template v-if="messageCost"> · {{ fmtCost(messageCost) }}</template></span>
        <span v-if="item.createdAt" class="footer-time">{{ fmtTime(item.createdAt) }}</span>
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
    <div v-if="deletedAttachments.has(item.attachmentId)" class="file-deleted">
      📎 {{ item.name }} — удалено
    </div>
    <template v-else>
      <div v-if="item.mime?.startsWith('image/')" class="file-image-wrap">
        <img :src="item.url" :alt="item.name" class="file-image" />
        <div class="row" style="gap:6px">
          <a href="#" @click.prevent="downloadViaFetch(item.url, item.name)" class="file-image-dl">Скачать</a>
          <button class="file-image-dl danger" @click="deleteFileFromChat(item.attachmentId)">Удалить</button>
        </div>
      </div>
      <div v-else class="file-card-wrap">
        <a class="file-card" href="#" @click.prevent="downloadViaFetch(item.url, item.name)">
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
        <button class="file-delete" title="Удалить вложение" @click="deleteFileFromChat(item.attachmentId)">×</button>
      </div>
    </template>
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
.msg-footer { display: flex; align-items: center; gap: 10px; margin-top: 6px; font-size: 0.7rem; color: var(--text-mute); }
.footer-provider { opacity: 0.7; flex-shrink: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.footer-tokens { opacity: 0.7; font-family: 'JetBrains Mono', monospace; flex-shrink: 0; margin-left: auto; }
.footer-time { opacity: 0.55; flex-shrink: 0; font-family: 'JetBrains Mono', monospace; }

/* ── Copy button: верхний правый угол bubble, на hover, в цвет bubble ── */
.copy-btn,
.user-copy {
  position: absolute; top: 6px; right: 8px;
  border: 1px solid transparent; border-radius: 4px;
  background: transparent; color: var(--text-mute); cursor: pointer;
  font-family: inherit; font-size: 0.78rem; line-height: 1;
  padding: 3px 7px;
  opacity: 0; transition: opacity 0.12s, color 0.12s, background 0.12s, border-color 0.12s;
}
/* подложка в цвет соответствующего bubble — иконка не мажет текст */
.assistant:hover .copy-btn {
  opacity: 1; background: var(--bg-soft);
  border-color: color-mix(in srgb, var(--text-mute) 18%, transparent);
}
.user:hover .user-copy {
  opacity: 1; background: var(--accent-soft);
  border-color: color-mix(in srgb, var(--accent) 25%, transparent);
}
.copy-btn:hover, .user-copy:hover {
  color: var(--accent);
  border-color: var(--accent);
}

/* User-attachments — компактные превью/чипы справа */
.user-attachments {
  display: flex; flex-direction: column; align-items: flex-end;
  gap: 6px; margin-bottom: 4px;
}
.user-attach-img {
  position: relative;
  display: flex; flex-direction: column; align-items: stretch;
  max-width: 220px;
  border-radius: 8px; overflow: hidden;
  background: var(--accent-soft);
  border: 1px solid color-mix(in srgb, var(--accent) 25%, transparent);
}
.user-attach-img a {
  display: block; line-height: 0;
  background: var(--bg-mute, var(--border));
}
.user-attach-img img {
  display: block; width: 100%; max-height: 160px; object-fit: cover;
}
.user-attach-meta {
  display: flex; align-items: center; gap: 6px;
  padding: 4px 8px;
  font-size: 0.72rem; line-height: 1.2;
  color: var(--text-mute);
  min-width: 0;
}
.user-attach-meta .user-attach-name {
  flex: 1; min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.user-attach-id {
  flex-shrink: 0;
  font-family: 'JetBrains Mono', monospace; font-size: 0.66rem;
  padding: 0 4px; border-radius: 3px;
  background: color-mix(in srgb, var(--accent) 18%, transparent);
  color: var(--text-mute);
}
.user-attach-del {
  position: absolute; top: 4px; right: 4px;
  width: 22px; height: 22px;
  border: none; border-radius: 4px;
  background: rgba(0,0,0,0.45); color: #fff; cursor: pointer;
  font-size: 0.95rem; line-height: 1;
  opacity: 0; transition: opacity 0.15s, background 0.15s;
  display: flex; align-items: center; justify-content: center;
}
.user-attach-img:hover .user-attach-del,
.user-attach-chip:hover .user-attach-del { opacity: 1; }
.user-attach-del:hover { background: var(--danger, #ef4444); }

.user-attach-chip {
  position: relative;
  display: inline-flex; align-items: center; gap: 6px;
  max-width: 320px;
  padding: 5px 28px 5px 10px;
  background: var(--accent-soft);
  border: 1px solid color-mix(in srgb, var(--accent) 25%, transparent);
  border-radius: 6px;
  font-size: 0.85rem; color: var(--text);
  text-decoration: none;
}
.user-attach-chip .user-attach-link {
  display: inline-flex; align-items: center; gap: 6px;
  color: inherit; text-decoration: none;
  min-width: 0;
}
.user-attach-chip .user-attach-name {
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  max-width: 220px;
}
.user-attach-chip .user-attach-del {
  /* для чипа кнопка inline в правой части — overlay-подложка не нужна */
  position: absolute; top: 50%; right: 4px; transform: translateY(-50%);
  background: transparent; color: var(--text-mute);
  width: 20px; height: 20px;
}
.user-attach-chip:hover .user-attach-del { opacity: 0.7; }
.user-attach-chip .user-attach-del:hover { color: var(--danger, #ef4444); background: transparent; }
.user-attach-deleted {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 4px 10px; border-radius: 6px;
  background: color-mix(in srgb, var(--text-mute) 12%, var(--bg));
  color: var(--text-mute); font-size: 0.85rem; font-style: italic;
  text-decoration: line-through;
}

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
.file-image-dl { font-size: 0.8rem; color: var(--accent); text-decoration: none; background: none; border: none; cursor: pointer; padding: 0; }
.file-image-dl:hover { text-decoration: underline; }
.file-image-dl.danger { color: var(--danger); }
.file-card-wrap { display: inline-flex; align-items: center; gap: 4px; }
.file-delete {
  border: none; background: transparent; color: var(--text-mute); cursor: pointer;
  font-size: 1rem; padding: 4px 8px; border-radius: 4px;
}
.file-delete:hover { background: #fee; color: var(--danger); }
.file-deleted {
  font-size: 0.85rem; color: var(--text-mute); font-style: italic;
  padding: 8px 12px; border: 1px dashed var(--border); border-radius: 6px;
  display: inline-block;
}
</style>
