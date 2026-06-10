<script setup lang="ts">
import { nextTick, ref } from 'vue'
import { calcCost, type Cost, type Chat, type Settings, type TokenStats } from '../api'
import { fmtCost, fmtTok } from '../utils'
import { t } from '../i18n'

const props = defineProps<{
  chats: Chat[]
  activeId: string | null
  totalStats: TokenStats | null
  totalCost: Cost | null
  settings: Settings | null
  open: boolean
  pendingDeleteAll?: { remaining: number } | null
}>()
const emit = defineEmits<{
  new: []
  select: [id: string]
  delete: [id: string]
  deleteAll: []
  undoDeleteAll: []
  rename: [id: string, title: string]
  toggle: []
}>()

function chatCost(c: Chat) {
  if (!props.settings) return null
  if (!c.tokensPrompt && !c.tokensCompletion && !c.totalCost) return null
  return calcCost(c.tokensPrompt, c.tokensCompletion, c.tokensCached ?? 0, {
    provider: props.settings.provider,
    tokensCost: c.totalCost,
    priceInput: props.settings.priceInput,
    priceOutput: props.settings.priceOutput,
    priceCached: props.settings.priceCached,
  })
}

const renaming = ref<string | null>(null)
const renameVal = ref('')
const renameInput = ref<HTMLInputElement | null>(null)

function startRename(c: Chat, e: MouseEvent) {
  e.stopPropagation()
  renaming.value = c.id
  renameVal.value = c.title
  nextTick(() => { renameInput.value?.select() })
}

function confirmRename(id: string) {
  const t = renameVal.value.trim()
  if (t) emit('rename', id, t)
  renaming.value = null
}

function onRenameKey(e: KeyboardEvent, id: string) {
  if (e.key === 'Enter') confirmRename(id)
  if (e.key === 'Escape') renaming.value = null
}
</script>

<template>
  <aside class="sidebar" :class="{ collapsed: !open }">
    <div class="sidebar-header">
      <template v-if="open">
        <span class="title">{{ t('chat.list') }}</span>
        <button class="icon-btn" @click="emit('new')" :title="t('chat.new')" :aria-label="t('chat.new')">+</button>
        <button
          v-if="chats.length > 1 && !pendingDeleteAll"
          class="icon-btn danger"
          @click="emit('deleteAll')"
          :title="t('chat.deleteAll')"
          :aria-label="t('chat.deleteAll')"
        >🗑</button>
      </template>
      <button class="ghost collapse-btn" :title="open ? t('common.collapse') : t('common.expand')" @click="emit('toggle')">
        {{ open ? '‹' : '›' }}
      </button>
    </div>
    <template v-if="open">
      <div v-if="pendingDeleteAll" class="banner-undo">
        <span>{{ t('chat.deleteAllPending', { remaining: pendingDeleteAll.remaining }) }}</span>
        <button class="ghost small" @click="emit('undoDeleteAll')">{{ t('chat.undo') }}</button>
      </div>
      <div class="sidebar-body">
        <div v-if="!chats.length" class="empty">{{ t('chat.empty') }}</div>
        <div
          v-for="c in chats"
          :key="c.id"
          class="chat-list-item"
          :class="{ active: c.id === activeId }"
          @click="renaming !== c.id && emit('select', c.id)"
        >
          <div class="label-col">
            <input
              v-if="renaming === c.id"
              ref="renameInput"
              v-model="renameVal"
              class="rename-input"
              @blur="confirmRename(c.id)"
              @keydown="onRenameKey($event, c.id)"
              @click.stop
            />
            <span v-else class="label" @dblclick="startRename(c, $event)" :title="t('chat.doubleClickRename')">{{ c.title }}</span>
            <span
              v-if="c.tokensPrompt || c.tokensCompletion"
              class="chat-toks"
            >↑{{ fmtTok(c.tokensPrompt) }} ↓{{ fmtTok(c.tokensCompletion) }}<template v-if="c.tokensCached"> ⊙{{ fmtTok(c.tokensCached) }}</template><template v-if="chatCost(c) != null"> · {{ fmtCost(chatCost(c)!) }}</template></span>
          </div>
          <span class="badge" v-if="c.contextSns.length" :title="c.contextSns.join(', ')">
            {{ c.contextSns.length }}
          </span>
          <button class="ghost" :title="t('common.delete')" @click.stop="emit('delete', c.id)">×</button>
        </div>
      </div>
      <div class="sidebar-footer">
        <div>{{ t('chat.eachIsTask') }}</div>
        <div v-if="totalStats && (totalStats.totalPromptTokens || totalStats.totalCompletionTokens)" class="token-total">
          {{ t('chat.total') }}: ↑{{ fmtTok(totalStats.totalPromptTokens) }} ↓{{ fmtTok(totalStats.totalCompletionTokens) }}<template v-if="totalStats.totalCachedTokens"> ⊙{{ fmtTok(totalStats.totalCachedTokens) }}</template><template v-if="totalCost != null"> · {{ fmtCost(totalCost) }}</template>
        </div>
      </div>
    </template>
  </aside>
</template>

<style scoped>
.label-col { display: flex; flex-direction: column; flex: 1; min-width: 0; overflow: hidden; }
.chat-toks { font-size: 10px; color: var(--text-mute); opacity: 0.7; }
.rename-input {
  font: inherit; padding: 0 2px; height: 20px; width: 100%;
  border-radius: 3px; font-size: 13px;
}
.token-total {
  margin-top: 4px;
  font-size: 11px;
  opacity: 0.6;
}
.title { flex: 1; font-weight: 600; }
.icon-btn {
  width: 28px; height: 28px; padding: 0;
  display: inline-flex; align-items: center; justify-content: center;
  background: var(--bg); border: 1px solid var(--border); border-radius: 4px;
  font-size: 0.95rem; line-height: 1; cursor: pointer; color: var(--text-mute);
}
.icon-btn:hover { background: var(--bg-soft); color: var(--accent); border-color: var(--accent); }
.icon-btn.danger:hover { color: var(--danger); border-color: var(--danger); }
.banner-undo {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding: 6px 10px;
  background: color-mix(in srgb, #f59e0b 14%, var(--bg));
  color: #b45309; font-size: 0.78rem;
  border-bottom: 1px solid var(--border);
}
</style>
