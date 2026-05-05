<script setup lang="ts">
import { ref, computed, watch, nextTick, onBeforeUnmount } from 'vue'

const props = defineProps<{
  modelValue: string
  options: string[]
  placeholder?: string
  /** When true, free typing isn't accepted — input snaps back to a valid option on blur. */
  strict?: boolean
  /** Optional map of `option → badge`. Rendered after the option name. */
  badges?: Record<string, string>
}>()
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

const open = ref(false)
const query = ref(props.modelValue)
const highlight = ref(-1)
const inputEl = ref<HTMLInputElement | null>(null)
const rootEl = ref<HTMLElement | null>(null)

watch(() => props.modelValue, (v) => { query.value = v })

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase()
  if (!q || q === props.modelValue.toLowerCase()) return props.options
  return props.options.filter(o => o.toLowerCase().includes(q))
})

function select(value: string) {
  emit('update:modelValue', value)
  query.value = value
  open.value = false
  highlight.value = -1
}

function onFocus() {
  open.value = true
  // Show full list on focus, not just matches for current value
  query.value = ''
}

function onBlur() {
  // Defer close so item-mousedown registers first
  setTimeout(() => {
    open.value = false
    if (props.strict && !props.options.includes(query.value)) {
      query.value = props.modelValue   // snap back
    } else if (query.value !== props.modelValue) {
      // Allow free-typed value to commit on blur (non-strict)
      emit('update:modelValue', query.value)
    }
  }, 120)
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    open.value = true
    highlight.value = Math.min(filtered.value.length - 1, highlight.value + 1)
    void scrollToHighlight()
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    highlight.value = Math.max(0, highlight.value - 1)
    void scrollToHighlight()
  } else if (e.key === 'Enter') {
    if (open.value && highlight.value >= 0 && filtered.value[highlight.value]) {
      e.preventDefault()
      select(filtered.value[highlight.value]!)
    }
  } else if (e.key === 'Escape') {
    open.value = false
    query.value = props.modelValue
    inputEl.value?.blur()
  }
}

async function scrollToHighlight() {
  await nextTick()
  rootEl.value?.querySelector('.cb-item.active')?.scrollIntoView({ block: 'nearest' })
}

function onDocClick(e: MouseEvent) {
  if (!rootEl.value || !rootEl.value.contains(e.target as Node)) open.value = false
}
window.addEventListener('mousedown', onDocClick)
onBeforeUnmount(() => window.removeEventListener('mousedown', onDocClick))
</script>

<template>
  <div ref="rootEl" class="combobox" :class="{ open }">
    <input
      ref="inputEl"
      v-model="query"
      :placeholder="placeholder"
      autocomplete="off"
      @focus="onFocus"
      @blur="onBlur"
      @keydown="onKey"
    />
    <span class="cb-caret" @mousedown.prevent="inputEl?.focus()">▾</span>
    <ul v-if="open && filtered.length" class="cb-list">
      <li
        v-for="(o, i) in filtered"
        :key="o"
        class="cb-item"
        :class="{ active: i === highlight, picked: o === modelValue }"
        @mousedown.prevent="select(o)"
        @mouseenter="highlight = i"
      >
        <span>{{ o }}</span>
        <span v-if="badges?.[o]" class="cb-badge">{{ badges[o] }}</span>
      </li>
    </ul>
    <div v-else-if="open" class="cb-empty">ничего не найдено</div>
  </div>
</template>

<style scoped>
.combobox { position: relative; }
.combobox input {
  width: 100%; padding-right: 24px;
  font: inherit;
}
.cb-caret {
  position: absolute; right: 8px; top: 50%; transform: translateY(-50%);
  color: var(--text-mute); font-size: 0.7rem; cursor: pointer; pointer-events: auto;
}
.cb-list, .cb-empty {
  position: absolute; left: 0; right: 0; top: 100%;
  margin: 2px 0 0; padding: 4px 0;
  background: var(--bg); border: 1px solid var(--border); border-radius: 4px;
  list-style: none;
  max-height: 240px; overflow-y: auto;
  z-index: 50;
  box-shadow: 0 4px 12px rgba(0,0,0,0.08);
}
.cb-empty { padding: 6px 10px; color: var(--text-mute); font-size: 0.8rem; }
.cb-item {
  display: flex; align-items: center; gap: 8px;
  padding: 5px 10px; font-size: 0.85rem; cursor: pointer; color: var(--text);
  white-space: nowrap; overflow: hidden;
}
.cb-item > span:first-child { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.cb-badge {
  flex-shrink: 0;
  font-family: 'JetBrains Mono', monospace; font-size: 0.72rem;
  padding: 1px 6px; border-radius: 8px;
  background: var(--bg-soft); color: var(--text-mute);
}
.cb-item.active { background: var(--bg-soft); }
.cb-item.picked { color: var(--accent); font-weight: 500; }
</style>
