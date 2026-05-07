import { describe, expect, it } from 'bun:test'
import { pickContextLength } from '../src/server/settings.ts'

describe('pickContextLength', () => {
  it('читает context_length напрямую', () => {
    expect(pickContextLength({ context_length: 128000 })).toBe(128000)
  })

  it('читает context_window как алиас', () => {
    expect(pickContextLength({ context_window: 200000 })).toBe(200000)
  })

  it('читает max_input_tokens', () => {
    expect(pickContextLength({ max_input_tokens: 1000000 })).toBe(1000000)
  })

  it('OpenRouter-стиль: top_provider.context_length', () => {
    expect(pickContextLength({ id: 'foo', top_provider: { context_length: 65536 } })).toBe(65536)
  })

  it('Ollama-стиль: details.context_length', () => {
    expect(pickContextLength({ id: 'foo', details: { context_length: 8192 } })).toBe(8192)
  })

  it('строковое значение конвертируется', () => {
    expect(pickContextLength({ context_length: '128000' })).toBe(128000)
  })

  it('undefined для невалидных полей', () => {
    expect(pickContextLength({ context_length: 0 })).toBeUndefined()
    expect(pickContextLength({ context_length: -1 })).toBeUndefined()
    expect(pickContextLength({ context_length: 'не число' })).toBeUndefined()
    expect(pickContextLength({ id: 'foo' })).toBeUndefined()
  })

  it('первое валидное поле побеждает', () => {
    // context_length перед top_provider в порядке кандидатов
    expect(pickContextLength({
      context_length: 128000,
      top_provider: { context_length: 999999 },
    })).toBe(128000)
  })
})
