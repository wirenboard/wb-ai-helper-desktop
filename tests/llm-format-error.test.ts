import { describe, expect, it } from 'bun:test'
import { formatLlmError } from '../src/server/llm.ts'

describe('formatLlmError', () => {
  it('401 от AITunnel-стиль body', () => {
    const e = { error: { code: 401, message: 'Недействительный токен' } }
    const msg = formatLlmError(e)
    expect(msg).toContain('401')
    expect(msg).toContain('Недействительный')
  })

  it('402 — недостаточно средств', () => {
    const e = { status: 402, error: { message: 'No funds' } }
    const msg = formatLlmError(e)
    expect(msg).toContain('402')
    expect(msg).toMatch(/средств/i)
  })

  it('403 с metadata — модерация с reasons и flagged_input', () => {
    const e = {
      error: {
        code: 403,
        message: 'Flagged',
        metadata: {
          reasons: ['hate', 'violence'],
          flagged_input: 'плохой текст',
          provider_name: 'openai',
        },
      },
    }
    const msg = formatLlmError(e)
    expect(msg).toContain('403')
    expect(msg).toContain('hate')
    expect(msg).toContain('violence')
    expect(msg).toContain('плохой текст')
    expect(msg).toContain('openai')
  })

  it('408 timeout', () => {
    const e = { status: 408, error: { message: 'Timed out' } }
    expect(formatLlmError(e)).toContain('408')
  })

  it('429 rate limit', () => {
    const e = { status: 429, error: { message: 'rate' } }
    const msg = formatLlmError(e)
    expect(msg).toContain('429')
    expect(msg).toMatch(/лимит/i)
  })

  it('502 с upstream raw', () => {
    const e = {
      error: {
        code: 502,
        message: 'Provider error',
        metadata: { provider_name: 'Venice', raw: 'rate-limited upstream' },
      },
    }
    const msg = formatLlmError(e)
    expect(msg).toContain('502')
    expect(msg).toContain('Venice')
    expect(msg).toContain('rate-limited upstream')
  })

  it('Неизвестная ошибка → fallback к message', () => {
    const e = new Error('something else')
    const msg = formatLlmError(e)
    expect(msg).toContain('something else')
  })
})
