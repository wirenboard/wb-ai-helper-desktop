import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SettingsStore } from '../src/server/settings.ts'

let dir: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'settings-test-'))
  file = join(dir, 'settings.json')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('SettingsStore', () => {
  test('load() returns defaults when no file exists', async () => {
    const store = new SettingsStore(file)
    const s = await store.load()
    expect(s.provider).toBe('openai')
    expect(s.sshUser).toBe('root')
    expect(s.sshPassword).toBe('wirenboard')
    expect(s.discoveryInterval).toBe(15000)
  })

  test('get() returns cached settings after load', async () => {
    const store = new SettingsStore(file)
    await store.load()
    const s = store.get()
    expect(s.provider).toBe('openai')
  })

  test('current() returns active provider config', async () => {
    const store = new SettingsStore(file)
    await store.load()
    const cur = store.current()
    expect(cur.apiFormat).toBe('openai')
  })

  test('update() persists changes', async () => {
    const store = new SettingsStore(file)
    await store.load()
    await store.update({ sshUser: 'admin' })
    expect(store.get().sshUser).toBe('admin')
    // Reload from disk
    const store2 = new SettingsStore(file)
    const s2 = await store2.load()
    expect(s2.sshUser).toBe('admin')
  })

  test('update() routes provider fields to active provider', async () => {
    const store = new SettingsStore(file)
    await store.load()
    await store.update({ apiKey: 'sk-test-123', model: 'gpt-4o' })
    const cur = store.current()
    expect(cur.apiKey).toBe('sk-test-123')
    expect(cur.model).toBe('gpt-4o')
  })

  test('update() switches provider when provider field is in patch', async () => {
    const store = new SettingsStore(file)
    await store.load()
    await store.update({ provider: 'custom', baseURL: 'http://localhost:11434/v1' })
    expect(store.get().provider).toBe('custom')
    expect(store.current().baseURL).toBe('http://localhost:11434/v1')
  })

  test('update() routes to switched-to provider', async () => {
    const store = new SettingsStore(file)
    await store.load()
    // Set a key on openai first
    await store.update({ apiKey: 'openai-key' })
    // Now switch to custom with a different key
    await store.update({ provider: 'custom', apiKey: 'custom-key' })
    // OpenAI key should be unchanged
    expect(store.get().providers.openai.apiKey).toBe('openai-key')
    expect(store.get().providers.custom.apiKey).toBe('custom-key')
  })

  test('toPublic() strips secrets', async () => {
    const store = new SettingsStore(file)
    await store.load()
    await store.update({ apiKey: 'secret-key', sshPassword: 'secret-pass' })
    const pub = store.toPublic()
    expect(pub.apiKeyConfigured).toBe(true)
    expect(pub.sshPasswordConfigured).toBe(true)
    // apiKey should NOT be in the public object
    expect((pub as any).apiKey).toBeUndefined()
    // providers should have apiKeyConfigured instead of apiKey
    expect(pub.providers.openai.apiKeyConfigured).toBe(true)
    expect((pub.providers.openai as any).apiKey).toBeUndefined()
  })

  test('clearKey() resets apiKey for current provider', async () => {
    const store = new SettingsStore(file)
    await store.load()
    await store.update({ apiKey: 'will-be-cleared' })
    expect(store.current().apiKey).toBe('will-be-cleared')
    await store.clearKey()
    expect(store.current().apiKey).toBe('')
  })

  test('onChange listener called on update', async () => {
    const store = new SettingsStore(file)
    await store.load()
    let called = false
    const unsub = store.onChange(() => { called = true })
    await store.update({ sshUser: 'test' })
    expect(called).toBe(true)
    unsub()
  })

  test('onChange unsubscribe works', async () => {
    const store = new SettingsStore(file)
    await store.load()
    let count = 0
    const unsub = store.onChange(() => { count++ })
    await store.update({ sshUser: 'a' })
    unsub()
    await store.update({ sshUser: 'b' })
    expect(count).toBe(1)
  })

  test('settings file written with restricted permissions', async () => {
    const store = new SettingsStore(file)
    await store.load()
    await store.update({ sshUser: 'test' })
    const st = statSync(file)
    // 0o600 = owner read+write only
    const mode = st.mode & 0o777
    expect(mode).toBe(0o600)
  })

  test('storagePath returns file path', async () => {
    const store = new SettingsStore(file)
    await store.load()
    expect(store.storagePath()).toBe(file)
  })
})
