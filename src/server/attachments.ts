import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'

let ROOT = ''

export function initAttachments(rootDir: string): void {
  ROOT = rootDir
}

const SESSION_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/
const ID_RE = /^[a-z0-9]{8}$/

export const limits = {
  maxFileBytes: 200 * 1024 * 1024,
  maxSessionBytes: 500 * 1024 * 1024,
  maxFilesPerSession: 20,
  ttlMs: 24 * 60 * 60 * 1000
}

export type AttachmentSource = 'user' | 'assistant'

export interface AttachmentMeta {
  id: string
  name: string
  mime: string
  size: number
  createdAt: number
  /**
   * Where the attachment came from:
   *  - 'user': uploaded by the user via the UI; lives in the input strip and
   *    is sent back to the LLM with the user's next message.
   *  - 'assistant': produced by a tool call (fetch_from_controller, get_history_chart…);
   *    rendered inline in chat as a message; NOT shown in the input strip; NOT
   *    re-sent to the LLM.
   */
  source: AttachmentSource
}

function sessionDir(sessionId: string): string {
  if (!SESSION_ID_RE.test(sessionId)) throw new Error('invalid sessionId')
  return join(ROOT, sessionId)
}

function sanitizeName(n: string): string {
  const cleaned = n.replace(/[/\\\x00-\x1f]/g, '').replace(/^\.+/, '').trim()
  if (!cleaned) throw new Error('invalid filename')
  return cleaned.slice(0, 200)
}

function genId(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let out = ''
  for (let i = 0; i < 8; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)]
  return out
}

function parseFilename(fname: string): { id: string; name: string; source: AttachmentSource } | null {
  const idx = fname.indexOf('__')
  if (idx < 0) return null
  const head = fname.slice(0, idx)
  const name = fname.slice(idx + 2)
  if (!name) return null
  // New format: ${id}_${u|a}, e.g. "ab12cd34_u". Old format: just ${id}.
  let id = head
  let source: AttachmentSource = 'user'
  const m = head.match(/^([a-z0-9]{8})_([ua])$/)
  if (m) { id = m[1]!; source = m[2] === 'a' ? 'assistant' : 'user' }
  if (!ID_RE.test(id)) return null
  return { id, name, source }
}

const MIME_TABLE: Record<string, string> = {
  txt: 'text/plain',
  log: 'text/plain',
  md: 'text/markdown',
  json: 'application/json',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  conf: 'text/plain',
  ini: 'text/plain',
  js: 'text/javascript',
  ts: 'text/typescript',
  py: 'text/x-python',
  sh: 'text/x-shellscript',
  csv: 'text/csv',
  xml: 'application/xml',
  html: 'text/html',
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  zip: 'application/zip',
  tar: 'application/x-tar',
  gz: 'application/gzip'
}

function mimeOf(name: string): string {
  const dot = name.lastIndexOf('.')
  if (dot < 0) return 'application/octet-stream'
  const ext = name.slice(dot + 1).toLowerCase()
  return MIME_TABLE[ext] ?? 'application/octet-stream'
}

function findFile(sessionId: string, id: string): { path: string; name: string; source: AttachmentSource } | null {
  if (!ID_RE.test(id)) return null
  const dir = sessionDir(sessionId)
  if (!existsSync(dir)) return null
  for (const fname of readdirSync(dir)) {
    const parsed = parseFilename(fname)
    if (parsed?.id === id) return { path: join(dir, fname), name: parsed.name, source: parsed.source }
  }
  return null
}

export function listSession(sessionId: string, source?: AttachmentSource): AttachmentMeta[] {
  const dir = sessionDir(sessionId)
  if (!existsSync(dir)) return []
  const out: AttachmentMeta[] = []
  for (const fname of readdirSync(dir)) {
    const parsed = parseFilename(fname)
    if (!parsed) continue
    if (source && parsed.source !== source) continue
    const st = statSync(join(dir, fname))
    out.push({
      id: parsed.id,
      name: parsed.name,
      mime: mimeOf(parsed.name),
      size: st.size,
      createdAt: st.mtimeMs,
      source: parsed.source,
    })
  }
  return out.sort((a, b) => a.createdAt - b.createdAt)
}

export function getAttachment(sessionId: string, id: string): AttachmentMeta | null {
  const f = findFile(sessionId, id)
  if (!f) return null
  const st = statSync(f.path)
  return {
    id,
    name: f.name,
    mime: mimeOf(f.name),
    size: st.size,
    createdAt: st.mtimeMs,
    source: f.source,
  }
}

export function readAttachment(sessionId: string, id: string): Buffer | null {
  const f = findFile(sessionId, id)
  if (!f) return null
  return readFileSync(f.path)
}

export type SaveResult =
  | { ok: true; meta: AttachmentMeta }
  | { ok: false; error: string }

export function saveAttachment(
  sessionId: string,
  name: string,
  content: Buffer,
  source: AttachmentSource = 'user',
): SaveResult {
  let cleanName: string
  try {
    cleanName = sanitizeName(name)
  } catch {
    return { ok: false, error: 'invalid filename' }
  }
  if (content.length === 0) return { ok: false, error: 'empty file' }
  if (content.length > limits.maxFileBytes) {
    return { ok: false, error: `file too large (limit ${limits.maxFileBytes} bytes)` }
  }
  const existing = listSession(sessionId)
  if (existing.length >= limits.maxFilesPerSession) {
    return { ok: false, error: `too many files in session (max ${limits.maxFilesPerSession})` }
  }
  const total = existing.reduce((n, a) => n + a.size, 0) + content.length
  if (total > limits.maxSessionBytes) {
    return { ok: false, error: `session quota exceeded (limit ${limits.maxSessionBytes} bytes)` }
  }
  const dir = sessionDir(sessionId)
  mkdirSync(dir, { recursive: true })
  const id = genId()
  const sourceTag = source === 'assistant' ? 'a' : 'u'
  const path = join(dir, `${id}_${sourceTag}__${cleanName}`)
  writeFileSync(path, content)
  const st = statSync(path)
  return {
    ok: true,
    meta: {
      id,
      name: cleanName,
      mime: mimeOf(cleanName),
      size: st.size,
      createdAt: st.mtimeMs,
      source,
    }
  }
}

export function deleteAttachment(sessionId: string, id: string): boolean {
  const f = findFile(sessionId, id)
  if (!f) return false
  unlinkSync(f.path)
  return true
}

export function clearSession(sessionId: string): void {
  const dir = sessionDir(sessionId)
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
}

export function cleanupExpired(): { removedSessions: number; removedFiles: number } {
  if (!ROOT || !existsSync(ROOT)) return { removedSessions: 0, removedFiles: 0 }
  const now = Date.now()
  let removedSessions = 0
  let removedFiles = 0
  for (const name of readdirSync(ROOT)) {
    const dir = join(ROOT, name)
    const st = statSync(dir)
    if (!st.isDirectory()) continue
    const files = readdirSync(dir)
    if (files.length === 0) {
      rmSync(dir, { recursive: true, force: true })
      removedSessions++
      continue
    }
    const newest = Math.max(...files.map((f) => statSync(join(dir, f)).mtimeMs))
    if (now - newest > limits.ttlMs) {
      removedFiles += files.length
      rmSync(dir, { recursive: true, force: true })
      removedSessions++
    }
  }
  return { removedSessions, removedFiles }
}
