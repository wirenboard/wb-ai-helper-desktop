<script setup lang="ts">
import { ref, computed, nextTick, watch } from 'vue'
import { useAttachments } from '../composables/useAttachments'
import { fmtSize, plural } from '../utils'

const props = defineProps<{ disabled: boolean; llmConfigured: boolean; chatId: string }>()
const emit = defineEmits<{ send: [text: string]; abort: [] }>()

const COLLAPSE_AT = 3

const { items, upload, remove, downloadUrl, removeAll, downloadAll, clear } = useAttachments(() => props.chatId, { source: 'user' })

const text = ref('')
const quote = ref('')
const textareaRef = ref<HTMLTextAreaElement | null>(null)
const fileInputRef = ref<HTMLInputElement | null>(null)
const dragOver = ref(false)
const uploadError = ref('')
const uploading = ref(false)
const stripExpanded = ref(false)

const stripCollapsed = computed(() => items.value.length > COLLAPSE_AT && !stripExpanded.value)
const filesPopupOpen = ref(false)
const totalSize = computed(() => items.value.reduce((n, a) => n + a.size, 0))

function setQuote(q: string) {
  quote.value = q
  text.value = ''
  nextTick(() => textareaRef.value?.focus())
}
defineExpose({ setQuote })

// Inline-уведомление под textarea — показываем мягкую подсказку когда юзер
// нажал Enter во время стрима. Текстарея специально не блокируется:
// можно набирать следующий вопрос пока модель отвечает.
const streamingNotice = ref<string | null>(null)
let noticeTimer: ReturnType<typeof setTimeout> | null = null

function flashNotice(msg: string, ms = 5000) {
  streamingNotice.value = msg
  if (noticeTimer) clearTimeout(noticeTimer)
  noticeTimer = setTimeout(() => { streamingNotice.value = null }, ms)
}

// Когда стрим закончился — подсказка больше не нужна, прячем сразу.
watch(() => props.disabled, (now) => {
  if (!now && streamingNotice.value) {
    streamingNotice.value = null
    if (noticeTimer) { clearTimeout(noticeTimer); noticeTimer = null }
  }
})

function submit() {
  const v = text.value.trim()
  if (!v && !items.value.length) return
  if (props.disabled) {
    // Модель отвечает — не теряем введённый текст, объясняем что делать.
    flashNotice('Модель ещё отвечает. Дождись её ответа и нажми Enter ещё раз — или нажми «■ Прервать», и можно будет отправить сразу.')
    return
  }
  const msg = quote.value ? `> ${quote.value.replace(/\n/g, '\n> ')}\n\n${v}` : v || items.value.map(a => `📎 ${a.name}`).join(', ')
  emit('send', msg)
  text.value = ''
  quote.value = ''
  // Files have been sent — visually clear the strip. They stay on disk for
  // list_attachments / read_attachment / upload_to_controller use later.
  clear()
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() }
}

function onPaste(e: ClipboardEvent) {
  const files: File[] = []
  Array.from(e.clipboardData?.items ?? []).forEach(item => {
    if (item.kind === 'file') { const f = item.getAsFile(); if (f) files.push(f) }
  })
  if (files.length) { e.preventDefault(); void handleFiles(files) }
}

async function handleFiles(files: FileList | File[]) {
  uploadError.value = ''
  uploading.value = true
  for (const f of Array.from(files)) {
    const r = await upload(f)
    if (!r.ok) { uploadError.value = `${f.name}: ${r.error}`; break }
  }
  uploading.value = false
}

function onDragEnter(e: DragEvent) { if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); dragOver.value = true } }
function onDragOver(e: DragEvent) { if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); dragOver.value = true } }
function onDragLeave(e: DragEvent) { if (e.currentTarget === e.target) dragOver.value = false }
function onDrop(e: DragEvent) { e.preventDefault(); dragOver.value = false; if (e.dataTransfer?.files.length) void handleFiles(e.dataTransfer.files) }

function onFileChange(e: Event) {
  const input = e.target as HTMLInputElement
  if (input.files?.length) void handleFiles(input.files)
  input.value = ''
}


</script>

<template>
  <form
    class="input-area"
    :class="{ 'drag-over': dragOver }"
    @submit.prevent="submit"
    @dragenter="onDragEnter"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
    <!-- Attachment strip -->
    <div v-if="items.length" class="attach-strip">
      <div v-if="items.length > COLLAPSE_AT" class="strip-head">
        <button type="button" class="strip-toggle" @click="stripExpanded = !stripExpanded">
          <span>📎</span>
          <span class="strip-count">{{ items.length }} {{ plural(items.length, ['файл', 'файла', 'файлов']) }}</span>
          <span class="strip-size">{{ fmtSize(totalSize) }}</span>
          <span class="caret">{{ stripExpanded ? '▾' : '▸' }}</span>
        </button>
        <button type="button" class="strip-action" title="Скачать все" @click="downloadAll">⬇ все</button>
        <button type="button" class="strip-action danger" title="Удалить все" @click="removeAll">× все</button>
      </div>
      <div v-if="!stripCollapsed" class="strip-chips">
        <a v-for="a in items" :key="a.id" class="chip" :href="downloadUrl(a.id)" :download="a.name" :title="`${a.name} · ${fmtSize(a.size)}`">
          <span>📎</span>
          <span class="chip-name">{{ a.name }}</span>
          <span class="chip-size">{{ fmtSize(a.size) }}</span>
          <button type="button" class="chip-remove" :aria-label="`Удалить ${a.name}`" @click.stop.prevent="remove(a.id)">×</button>
        </a>
      </div>
    </div>

    <div v-if="uploadError" class="upload-error">⚠ {{ uploadError }}</div>

    <!-- Quote bar -->
    <div v-if="quote" class="quote-bar">
      <span class="quote-text">{{ quote.length > 120 ? quote.slice(0, 120) + '…' : quote }}</span>
      <button type="button" class="quote-close" @click="quote = ''">×</button>
    </div>

    <textarea
      ref="textareaRef"
      v-model="text"
      :placeholder="llmConfigured ? 'Спросите ассистента… (Enter — отправить, Shift+Enter — перенос)' : 'API-ключ не настроен — откройте Настройки'"
      :disabled="!llmConfigured"
      rows="2"
      @keydown="onKey"
      @paste="onPaste"
    />
    <div v-if="streamingNotice" class="streaming-notice">
      {{ streamingNotice }}
    </div>

    <div class="buttons">
      <input ref="fileInputRef" type="file" multiple hidden @change="onFileChange" />
      <button type="button" class="attach" :disabled="uploading" :title="uploading ? 'Загрузка…' : 'Прикрепить файл'" @click="fileInputRef?.click()">📎</button>
      <span class="downloads-hint" title="В Chrome Ctrl+J открывает список скачанных файлов с пунктом «Показать в папке»"><kbd>Ctrl+J</kbd> — скачанные файлы</span>
      <button v-if="disabled" type="button" class="abort" @click="emit('abort')">■ Прервать</button>
      <button type="submit" class="send" :disabled="disabled || !llmConfigured || (!text.trim() && !items.length)">Отправить</button>
    </div>
  </form>
</template>

<style scoped>
.input-area {
  display: flex; flex-direction: column; gap: 6px;
  border-top: 1px solid var(--border); padding: 10px 12px;
  background: var(--bg-soft); position: relative;
}
.input-area.drag-over::after {
  content: 'Отпустите файл для загрузки';
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  background: rgba(var(--accent-rgb, 31,122,236), 0.08); border: 2px dashed var(--accent);
  color: var(--accent); font-weight: 700; font-size: 0.875rem; z-index: 1; pointer-events: none;
}

/* ── Attachment strip ───────────────────────────────────────── */
.attach-strip { display: flex; flex-direction: column; gap: 4px; }
.strip-chips { display: flex; flex-wrap: wrap; gap: 4px; }
.strip-head { display: flex; gap: 4px; align-items: center; }
.strip-toggle {
  display: inline-flex; align-items: center; gap: 6px; flex: 1; min-width: 0;
  border: 1px dashed var(--border); background: var(--bg); border-radius: 4px; padding: 4px 8px;
  font-family: 'JetBrains Mono', monospace; font-size: 0.6875rem; color: var(--text-mute); cursor: pointer; text-align: left;
}
.strip-toggle:hover { background: var(--bg-soft); }
.strip-count { font-weight: 700; color: var(--text); }
.strip-size { color: var(--text-mute); }
.caret { margin-left: auto; color: var(--text-mute); }
.strip-action {
  padding: 4px 8px; background: var(--bg); border: 1px solid var(--border);
  border-radius: 4px; font-family: 'JetBrains Mono', monospace; font-size: 0.6875rem;
  color: var(--text-mute); cursor: pointer; white-space: nowrap;
}
.strip-action:hover { background: var(--bg-soft); color: var(--accent); border-color: var(--accent); }
.strip-action.danger:hover { color: var(--danger); border-color: var(--danger); background: var(--bg); }

.chip {
  display: inline-flex; align-items: center; gap: 4px;
  background: var(--bg); border: 1px solid var(--border); border-radius: 12px;
  padding: 2px 4px 2px 8px; font-size: 0.6875rem; color: var(--text); text-decoration: none; max-width: 240px;
}
.chip:hover { background: var(--bg-soft); }
.chip-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 140px; }
.chip-size { color: var(--text-mute); font-family: 'JetBrains Mono', monospace; font-size: 0.625rem; }
.chip-remove { border: none; background: transparent; color: var(--text-mute); font-size: 0.875rem; line-height: 1; padding: 0 4px; cursor: pointer; border-radius: 50%; }
.chip-remove:hover { background: #fee; color: var(--danger); }

.upload-error { font-size: 0.6875rem; color: var(--danger); background: #fef2f2; border: 1px solid #fbb; border-radius: 4px; padding: 4px 8px; }

/* ── Quote bar ──────────────────────────────────────────────── */
.quote-bar {
  display: flex; align-items: center; gap: 6px; padding: 4px 8px;
  background: var(--accent-soft); border-left: 3px solid var(--accent);
  border-radius: 4px; font-size: 0.75rem; color: var(--text-mute);
}
.quote-text { flex: 1; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.quote-close { border: none; background: none; cursor: pointer; color: var(--text-mute); font-size: 1rem; padding: 0 2px; }
.quote-close:hover { color: var(--text); }

/* ── Textarea + buttons ─────────────────────────────────────── */
textarea {
  resize: none; font-family: inherit; font-size: 0.8125rem;
  border: 1px solid var(--border); border-radius: 4px; padding: 6px 8px;
  outline: none; background: var(--bg); color: var(--text);
}
textarea:focus { border-color: var(--accent); }
.buttons { display: flex; justify-content: flex-end; gap: 6px; align-items: center; }
.attach {
  padding: 4px 10px; background: var(--bg); border: 1px solid var(--border);
  border-radius: 4px; font-size: 0.875rem; cursor: pointer; color: var(--text-mute);
}
.attach:hover { background: var(--bg-soft); color: var(--accent); }
.attach:disabled { opacity: 0.5; cursor: not-allowed; }
.abort {
  padding: 4px 14px; background: var(--bg); color: var(--danger);
  border: 1px solid var(--danger); border-radius: 4px; font-family: inherit; font-size: 0.8125rem; cursor: pointer;
}
.abort:hover { background: #fff0f0; }
.send {
  padding: 4px 14px; background: var(--accent); color: #fff;
  border: none; border-radius: 4px; font-family: inherit; font-size: 0.8125rem; cursor: pointer;
}
.send:hover { filter: brightness(1.1); }
.send:disabled { background: var(--border); cursor: not-allowed; }
.streaming-notice {
  font-size: 0.78rem;
  color: var(--text-mute);
  padding: 6px 8px;
  border-left: 2px solid var(--accent);
  background: color-mix(in srgb, var(--accent) 6%, var(--bg));
  border-radius: 3px;
  margin-top: 4px;
}
.downloads-hint {
  font-size: 0.7rem; color: var(--text-mute); opacity: 0.65;
  margin-right: auto; margin-left: 6px; user-select: none;
}
.downloads-hint kbd {
  font-family: 'JetBrains Mono', monospace; font-size: 0.68rem;
  padding: 1px 4px; border: 1px solid var(--border); border-radius: 3px;
  background: var(--bg);
}
.badge-count {
  display: inline-block; min-width: 16px; padding: 0 4px; margin-left: 4px;
  background: var(--accent); color: #fff; border-radius: 8px;
  font-size: 0.7rem; line-height: 16px; text-align: center;
}
.files-popup {
  position: absolute; bottom: 48px; right: 12px;
  background: var(--bg); border: 1px solid var(--border); border-radius: 6px;
  width: min(360px, 90%); padding: 6px;
  box-shadow: 0 6px 20px rgba(0,0,0,0.12); z-index: 20;
}
.files-popup-head {
  display: flex; justify-content: space-between; align-items: center;
  font-size: 0.75rem; font-weight: 600; color: var(--text-mute);
  padding: 4px 6px; border-bottom: 1px solid var(--border); margin-bottom: 4px;
}
.files-popup-body { display: flex; flex-direction: column; max-height: 240px; overflow-y: auto; }
.files-popup-row {
  display: flex; align-items: center; gap: 6px;
  padding: 5px 6px; border-radius: 4px; text-decoration: none;
  color: var(--text); font-size: 0.8rem;
}
.files-popup-row:hover { background: var(--bg-soft); }
.files-popup-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.files-popup-size { color: var(--text-mute); font-family: 'JetBrains Mono', monospace; font-size: 0.7rem; }
.files-popup-rm { border: none; background: transparent; color: var(--text-mute); cursor: pointer; padding: 0 4px; }
.files-popup-rm:hover { color: var(--danger); }
</style>
