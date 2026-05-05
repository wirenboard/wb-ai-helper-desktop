import { ref } from 'vue'

export interface AttachmentMeta {
  id: string
  name: string
  mime: string
  size: number
  createdAt: number
}

export function useAttachments(chatIdGetter: () => string) {
  const items = ref<AttachmentMeta[]>([])

  async function refresh() {
    const chatId = chatIdGetter()
    if (!chatId) return
    try {
      const r = await fetch(`/api/attachments?chatId=${encodeURIComponent(chatId)}`)
      if (!r.ok) return
      const j = await r.json() as { items: AttachmentMeta[] }
      items.value = j.items
    } catch {
      /* ignore */
    }
  }

  async function upload(file: File): Promise<{ ok: true } | { ok: false; error: string }> {
    const chatId = chatIdGetter()
    const fd = new FormData()
    fd.append('chatId', chatId)
    fd.append('file', file)
    try {
      const r = await fetch('/api/attachments', { method: 'POST', body: fd })
      if (!r.ok) {
        const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }))
        return { ok: false, error: (j as { error?: string }).error ?? `HTTP ${r.status}` }
      }
      await refresh()
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  async function remove(id: string) {
    const chatId = chatIdGetter()
    try {
      await fetch(`/api/attachments/${encodeURIComponent(id)}?chatId=${encodeURIComponent(chatId)}`, { method: 'DELETE' })
      await refresh()
    } catch {
      /* ignore */
    }
  }

  function downloadUrl(id: string): string {
    const chatId = chatIdGetter()
    return `/api/attachments/${encodeURIComponent(id)}?chatId=${encodeURIComponent(chatId)}`
  }

  return { items, refresh, upload, remove, downloadUrl }
}
