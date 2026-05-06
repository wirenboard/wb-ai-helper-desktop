import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  initAttachments, saveAttachment, listSession, getAttachment,
  readAttachment, deleteAttachment, clearSession,
} from '../src/server/attachments.ts'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'att-test-'))
  initAttachments(dir)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('saveAttachment', () => {
  test('saves a file and returns metadata', () => {
    const result = saveAttachment('sess1', 'test.txt', Buffer.from('hello'))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.meta.name).toBe('test.txt')
      expect(result.meta.mime).toBe('text/plain')
      expect(result.meta.size).toBe(5)
      expect(result.meta.source).toBe('user')
    }
  })

  test('rejects empty file', () => {
    const result = saveAttachment('sess1', 'test.txt', Buffer.alloc(0))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('empty')
  })

  test('rejects invalid filename', () => {
    const result = saveAttachment('sess1', '...', Buffer.from('x'))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('invalid')
  })

  test('source=assistant creates assistant-tagged file', () => {
    const result = saveAttachment('sess1', 'output.svg', Buffer.from('<svg/>'), 'assistant')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.meta.source).toBe('assistant')
  })
})

describe('listSession', () => {
  test('empty for new session', () => {
    expect(listSession('new-session')).toEqual([])
  })

  test('returns saved attachments', () => {
    saveAttachment('sess1', 'a.txt', Buffer.from('a'))
    saveAttachment('sess1', 'b.txt', Buffer.from('bb'))
    expect(listSession('sess1')).toHaveLength(2)
  })

  test('filters by source', () => {
    saveAttachment('sess1', 'user.txt', Buffer.from('u'), 'user')
    saveAttachment('sess1', 'asst.txt', Buffer.from('a'), 'assistant')
    expect(listSession('sess1', 'user')).toHaveLength(1)
    expect(listSession('sess1', 'assistant')).toHaveLength(1)
  })
})

describe('getAttachment / readAttachment', () => {
  test('returns metadata for known id', () => {
    const r = saveAttachment('sess1', 'test.txt', Buffer.from('hello'))
    if (!r.ok) throw new Error('save failed')
    const meta = getAttachment('sess1', r.meta.id)
    expect(meta).not.toBeNull()
    expect(meta?.name).toBe('test.txt')
  })

  test('returns null for unknown id', () => {
    expect(getAttachment('sess1', 'zzzzzzzz')).toBeNull()
  })

  test('reads content back', () => {
    const r = saveAttachment('sess1', 'test.txt', Buffer.from('hello world'))
    if (!r.ok) throw new Error('save failed')
    const buf = readAttachment('sess1', r.meta.id)
    expect(buf?.toString()).toBe('hello world')
  })
})

describe('deleteAttachment', () => {
  test('deletes known file', () => {
    const r = saveAttachment('sess1', 'test.txt', Buffer.from('x'))
    if (!r.ok) throw new Error('save failed')
    expect(deleteAttachment('sess1', r.meta.id)).toBe(true)
    expect(getAttachment('sess1', r.meta.id)).toBeNull()
  })

  test('returns false for unknown id', () => {
    expect(deleteAttachment('sess1', 'zzzzzzzz')).toBe(false)
  })
})

describe('clearSession', () => {
  test('removes all attachments', () => {
    saveAttachment('sess1', 'a.txt', Buffer.from('a'))
    saveAttachment('sess1', 'b.txt', Buffer.from('b'))
    clearSession('sess1')
    expect(listSession('sess1')).toEqual([])
  })
})
