import { describe, test, expect, beforeAll } from 'bun:test'
import { openDb, type DbHandle } from '../src/server/db.ts'
import { ChatStore } from '../src/server/chats.ts'

let db: DbHandle
let store: ChatStore

beforeAll(async () => {
  db = await openDb(':memory:')
  store = new ChatStore(db)
})

describe('openDb', () => {
  test('creates tables successfully', () => {
    const tables = db.query<{ name: string }, []>(
      `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`
    ).all().map(r => r.name)
    expect(tables).toContain('chats')
    expect(tables).toContain('turns')
    expect(tables).toContain('skills')
    expect(tables).toContain('manual_controllers')
  })
})

describe('ChatStore', () => {
  test('list() returns empty on fresh DB', () => {
    expect(store.list()).toEqual([])
  })

  test('create() returns chat with id and title', () => {
    const chat = store.create('Test Chat')
    expect(chat.id).toBeTruthy()
    expect(chat.title).toBe('Test Chat')
    expect(chat.turns.length).toBeGreaterThanOrEqual(1) // system turn
  })

  test('create() default title', () => {
    const chat = store.create()
    expect(chat.title).toBe('Новый чат')
  })

  test('create() with contextSns includes them in system prompt', () => {
    const chat = store.create('Ctx test', ['SN1', 'SN2'])
    expect(chat.contextSns).toEqual(['SN1', 'SN2'])
    const sysTurn = chat.turns.find(t => t.role === 'system')
    expect(sysTurn?.content).toContain('SN1')
    expect(sysTurn?.content).toContain('SN2')
  })

  test('list() returns created chats', () => {
    const before = store.list().length
    store.create('Listed chat')
    expect(store.list().length).toBe(before + 1)
  })

  test('get() returns the chat with turns', () => {
    const created = store.create('Get test')
    const fetched = store.get(created.id)
    expect(fetched).toBeDefined()
    expect(fetched?.id).toBe(created.id)
    expect(fetched?.turns.length).toBeGreaterThanOrEqual(1)
  })

  test('get() returns undefined for non-existent id', () => {
    expect(store.get('nonexistent-id')).toBeUndefined()
  })

  test('rename() changes the title', () => {
    const chat = store.create('Old title')
    const renamed = store.rename(chat.id, 'New title')
    expect(renamed?.title).toBe('New title')
  })

  test('remove() deletes the chat', () => {
    const chat = store.create('To delete')
    store.remove(chat.id)
    expect(store.get(chat.id)).toBeUndefined()
  })

  test('setContext() updates contextSns and system turn', () => {
    const chat = store.create('Ctx update')
    const updated = store.setContext(chat.id, ['NEWSN'])
    expect(updated?.contextSns).toEqual(['NEWSN'])
    const sysTurn = updated?.turns.find(t => t.role === 'system')
    expect(sysTurn?.content).toContain('NEWSN')
  })

  test('appendTurn() adds a user turn', () => {
    const chat = store.create('Append test')
    store.appendTurn(chat.id, { role: 'user', content: 'Hello world' })
    const fetched = store.get(chat.id)!
    const userTurns = fetched.turns.filter(t => t.role === 'user')
    expect(userTurns).toHaveLength(1)
    expect(userTurns[0]?.content).toBe('Hello world')
  })

  test('appendTurn() adds assistant turn with toolCalls', () => {
    const chat = store.create('Tool test')
    const toolCalls = [{ id: 'tc1', name: 'ssh_exec', arguments: '{"cmd":"ls"}' }]
    store.appendTurn(chat.id, { role: 'assistant', content: '', toolCalls })
    const fetched = store.get(chat.id)!
    const asstTurn = fetched.turns.find(t => t.role === 'assistant')
    expect(asstTurn).toBeDefined()
    if (asstTurn?.role === 'assistant') {
      expect(asstTurn.toolCalls).toHaveLength(1)
      expect(asstTurn.toolCalls?.[0]?.name).toBe('ssh_exec')
    }
  })

  test('appendTurn() adds tool turn', () => {
    const chat = store.create('Tool result test')
    store.appendTurn(chat.id, { role: 'tool', toolCallId: 'tc1', content: 'result data' })
    const fetched = store.get(chat.id)!
    const toolTurn = fetched.turns.find(t => t.role === 'tool')
    expect(toolTurn).toBeDefined()
    if (toolTurn?.role === 'tool') {
      expect(toolTurn.toolCallId).toBe('tc1')
      expect(toolTurn.content).toBe('result data')
    }
  })

  test('appendTurn() with usage records tokens', () => {
    const chat = store.create('Usage test')
    store.appendTurn(chat.id,
      { role: 'assistant', content: 'Response' },
      { promptTokens: 100, completionTokens: 50, cachedTokens: 10, totalCost: 0.5 },
    )
    const fetched = store.get(chat.id)!
    expect(fetched.tokensPrompt).toBeGreaterThanOrEqual(100)
    expect(fetched.tokensCompletion).toBeGreaterThanOrEqual(50)
  })

  test('appendTurn() auto-titles on first user message', () => {
    const chat = store.create()
    expect(chat.title).toBe('Новый чат')
    store.appendTurn(chat.id, { role: 'user', content: 'Tell me about temperature sensors' })
    const fetched = store.get(chat.id)!
    expect(fetched.title).toBe('Tell me about temperature sensors')
  })

  test('globalStats() aggregates tokens', () => {
    const chat = store.create('Stats test')
    store.appendTurn(chat.id,
      { role: 'assistant', content: 'x' },
      { promptTokens: 200, completionTokens: 100 },
    )
    const stats = store.globalStats()
    expect(stats.totalPromptTokens).toBeGreaterThanOrEqual(200)
    expect(stats.totalCompletionTokens).toBeGreaterThanOrEqual(100)
  })

  test('systemPromptFor([]) mentions контроллеры не выбраны', () => {
    const prompt = store.systemPromptFor([])
    expect(prompt).toContain('контроллеры не выбраны')
  })

  test('systemPromptFor([SN1, SN2]) lists SNs', () => {
    const prompt = store.systemPromptFor(['SN1', 'SN2'])
    expect(prompt).toContain('SN1')
    expect(prompt).toContain('SN2')
  })
})
