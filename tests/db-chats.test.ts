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

  // Per-turn provider/model attribution (v0.13.8). Цель — чтобы подвал
  // ассистент-сообщения показывал того провайдера/модель/валюту, кем оно
  // было реально сгенерено, а не текущие глобальные settings. После
  // переключения провайдера прошлые сообщения должны остаться без изменений.
  test('appendTurn() persists provider/model attribution on assistant turn', () => {
    const chat = store.create('Attribution test')
    store.appendTurn(
      chat.id,
      { role: 'assistant', content: 'reply A' },
      { promptTokens: 100, completionTokens: 50 },
      { provider: 'aitunnel', model: 'gpt-4.1-mini' },
    )
    const fetched = store.get(chat.id)!
    const asst = fetched.turns.find((t) => t.role === 'assistant')
    expect(asst).toBeDefined()
    if (asst?.role === 'assistant') {
      expect(asst.provider).toBe('aitunnel')
      expect(asst.model).toBe('gpt-4.1-mini')
    }
  })

  test('appendTurn() does NOT persist attribution on user/tool/system turns', () => {
    const chat = store.create('Attribution scope')
    store.appendTurn(
      chat.id,
      { role: 'user', content: 'hi' },
      undefined,
      { provider: 'openai', model: 'gpt-4o' },
    )
    store.appendTurn(
      chat.id,
      { role: 'tool', toolCallId: 't1', content: 'ok' },
      undefined,
      { provider: 'openai', model: 'gpt-4o' },
    )
    const fetched = store.get(chat.id)!
    const user = fetched.turns.find((t) => t.role === 'user')
    const tool = fetched.turns.find((t) => t.role === 'tool')
    // Attribution имеет смысл только на assistant-турнах, в подвале которых
    // она и рендерится. На user/tool — лишние данные, не пишем.
    expect((user as any)?.provider).toBeUndefined()
    expect((tool as any)?.provider).toBeUndefined()
  })

  test('appendTurn() works without attribution (legacy / pre-migration turns)', () => {
    const chat = store.create('No attribution')
    store.appendTurn(
      chat.id,
      { role: 'assistant', content: 'reply' },
      { promptTokens: 10, completionTokens: 5 },
      // attribution не передаётся — должно работать как до v0.13.8
    )
    const fetched = store.get(chat.id)!
    const asst = fetched.turns.find((t) => t.role === 'assistant')
    if (asst?.role === 'assistant') {
      expect(asst.provider).toBeUndefined()
      expect(asst.model).toBeUndefined()
    }
  })

  // Auto-title (v0.13.7): welcome system_event и retry-баннеры приходят как
  // user-турны с префиксом «[Система]» — в качестве заголовка чата они не
  // годятся, его должна давать первая «настоящая» реплика юзера.
  test('auto-title skips [Система] user-turns', () => {
    const chat = store.create()
    expect(chat.title).toBe('Новый чат')
    // Welcome system_event при создании чата — не должен становиться заголовком.
    store.appendTurn(chat.id, {
      role: 'user',
      content: '[Система] OpenAI · gpt-5.4-mini · инструменты: 50 · скиллы: 17',
    })
    let fetched = store.get(chat.id)!
    expect(fetched.title).toBe('Новый чат')
    // Real user message — должна выставить title.
    store.appendTurn(chat.id, { role: 'user', content: 'Какая версия прошивки?' })
    fetched = store.get(chat.id)!
    expect(fetched.title).toBe('Какая версия прошивки?')
  })

  test('auto-title triggers on FIRST real user message even if [Система] turns precede it', () => {
    const chat = store.create()
    // Несколько подряд welcome/retry баннеров — title должен оставаться дефолтным.
    store.appendTurn(chat.id, { role: 'user', content: '[Система] welcome line' })
    store.appendTurn(chat.id, { role: 'user', content: '[Система] ⏳ retry-wait 10s' })
    store.appendTurn(chat.id, { role: 'user', content: '[Система] ещё одно уведомление' })
    let fetched = store.get(chat.id)!
    expect(fetched.title).toBe('Новый чат')
    // Первая реальная реплика юзера — title апдейтится.
    store.appendTurn(chat.id, { role: 'user', content: 'привет' })
    fetched = store.get(chat.id)!
    expect(fetched.title).toBe('привет')
  })

  // Принудительное сжатие (v0.13.12). Стратегия — keep system + last K turns
  // (default K=6), всё что между — synthetic [Система] уведомление. Это
  // покрывает оба сценария:
  //   а) много вопросов: остаётся последний user-msg и его ответ.
  //   б) один длинный вопрос с цепочкой tool-iterations: остаются последние
  //      несколько iter'ов которые показывают актуальное состояние.
  test('forceCompact() drops middle, keeps system + last K turns + inserts synthetic', () => {
    const chat = store.create('compact test')
    // Длинная цепочка чтобы было что сжимать (1 system + 14 turns).
    for (let i = 0; i < 7; i++) {
      store.appendTurn(chat.id, { role: 'user', content: `user msg ${i}` })
      store.appendTurn(chat.id, {
        role: 'assistant',
        content: `assistant ${i}`,
        toolCalls: [{ id: `t${i}`, name: 'foo', arguments: '{}' }],
      })
    }
    const before = store.get(chat.id)!
    expect(before.turns.length).toBe(15) // 1 system + 14 turns

    const result = store.forceCompact(chat.id, 'ratio=0.95', 6)
    expect(result.removed).toBe(15 - 1 - 6) // = 8 (всё кроме system + last 6)

    const after = store.get(chat.id)!
    // system + synthetic notice + 6 хвостовых turns = 8
    expect(after.turns.length).toBe(8)
    expect(after.turns[0]?.role).toBe('system')
    const notice = after.turns[1]
    expect(notice?.role).toBe('user')
    expect(notice?.content).toMatch(/^\[Система\] 🗜 Принудительное сжатие/)
    expect(notice?.content).toContain('ratio=0.95')
    // Хвост — последние 6 турнов (user msg 4..6 + assistants).
    expect(after.turns.slice(2).map((t) => (t.role === 'user' ? t.content : `[a]${t.content}`))).toEqual([
      'user msg 4',
      '[a]assistant 4',
      'user msg 5',
      '[a]assistant 5',
      'user msg 6',
      '[a]assistant 6',
    ])
  })

  test('forceCompact() summary notice describes what was dropped', () => {
    const chat = store.create('summary test')
    store.appendTurn(chat.id, { role: 'user', content: 'q1' })
    store.appendTurn(chat.id, {
      role: 'assistant',
      content: 'a1',
      toolCalls: [{ id: 't1', name: 'foo', arguments: '{}' }],
    })
    store.appendTurn(chat.id, { role: 'tool', toolCallId: 't1', content: 'res1' })
    store.appendTurn(chat.id, { role: 'user', content: '[Система] welcome' })
    // Final keepLast=2 кусок:
    store.appendTurn(chat.id, { role: 'user', content: 'last user' })
    store.appendTurn(chat.id, { role: 'assistant', content: 'last answer' })

    store.forceCompact(chat.id, 'manual', 2)
    const after = store.get(chat.id)!
    const notice = after.turns[1]!
    // Все типы выкинутого должны быть в сводке
    expect(notice.content).toContain('1 реплик')
    expect(notice.content).toContain('1 ответов модели')
    expect(notice.content).toContain('1 tool-результатов')
    expect(notice.content).toContain('1 system-уведомлений')
  })

  test('forceCompact() noop when chat has fewer than keepLast+1 turns', () => {
    const chat = store.create('small')
    store.appendTurn(chat.id, { role: 'user', content: 'q1' })
    store.appendTurn(chat.id, { role: 'assistant', content: 'a1' })
    // 1 system + 2 turns = 3 < 1 + 6 = 7 → no-op
    const result = store.forceCompact(chat.id, 'manual')
    expect(result.removed).toBe(0)
    const after = store.get(chat.id)!
    expect(after.turns.length).toBe(3)
  })
})
