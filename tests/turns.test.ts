// Unit tests for turnsToItems() — the turn→UI-item conversion logic.
// Run: bun test tests/turns.test.ts

import { describe, test, expect } from 'bun:test'
import { turnsToItems, type ChatTurn } from '../src/web/api'

function turns(ts: ChatTurn[]): ReturnType<typeof turnsToItems> {
  return turnsToItems(ts, 'test-chat')
}

describe('turnsToItems: user turns', () => {
  test('converts user turn', () => {
    const items = turns([{ role: 'user', content: 'hello' }])
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ type: 'user', text: 'hello' })
  })
})

describe('turnsToItems: assistant turns', () => {
  test('converts text-only assistant turn', () => {
    const items = turns([{ role: 'assistant', content: 'hi there' }])
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ type: 'assistant_text', text: 'hi there' })
  })

  test('skips empty assistant content', () => {
    const items = turns([{ role: 'assistant', content: '' }])
    expect(items).toHaveLength(0)
  })

  test('exposes token counts on assistant turn', () => {
    const items = turns([{ role: 'assistant', content: 'hi', tokensPrompt: 10, tokensCompletion: 5, tokensCached: 3 }])
    expect(items[0]).toMatchObject({ type: 'assistant_text', tokensPrompt: 10, tokensCompletion: 5, tokensCached: 3 })
  })

  test('creates tool_call item from toolCalls array', () => {
    const items = turns([{
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'c1', name: 'ssh_exec', arguments: '{"sn":"SN1","command":"ls"}' }],
    }])
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ type: 'tool_call', id: 'c1', name: 'ssh_exec', input: { sn: 'SN1', command: 'ls' } })
  })
})

describe('turnsToItems: tool result matching', () => {
  test('attaches result to matching tool_call', () => {
    const items = turns([
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'ssh_exec', arguments: '{}' }] },
      { role: 'tool', toolCallId: 'c1', content: 'some output' },
    ])
    expect(items).toHaveLength(1)
    const tc = items[0] as any
    expect(tc.result?.content).toBe('some output')
    expect(tc.result?.isError).toBe(false)
  })

  test('marks result as error when content has \\x01 prefix', () => {
    const items = turns([
      { role: 'assistant', content: '', toolCalls: [{ id: 'c2', name: 'ssh_exec', arguments: '{}' }] },
      { role: 'tool', toolCallId: 'c2', content: '\x01{"error":"connection refused"}' },
    ])
    const tc = items[0] as any
    expect(tc.result?.isError).toBe(true)
    expect(tc.result?.content).toBe('{"error":"connection refused"}')
  })

  test('isError false for normal result', () => {
    const items = turns([
      { role: 'assistant', content: '', toolCalls: [{ id: 'c3', name: 'get_controller', arguments: '{}' }] },
      { role: 'tool', toolCallId: 'c3', content: '{"hostname":"wb"}' },
    ])
    const tc = items[0] as any
    expect(tc.result?.isError).toBe(false)
  })
})

describe('turnsToItems: legacy ▶ format (live streaming buffer)', () => {
  test('parses ▶ format with ok separator', () => {
    const content = '▶ ssh_exec\n{"sn":"SN1"}\n— result —\nwb-controller\n[exit: 0]'
    const items = turns([{ role: 'tool', toolCallId: undefined as any, content }])
    const tc = items[0] as any
    expect(tc.type).toBe('tool_call')
    expect(tc.name).toBe('ssh_exec')
    expect(tc.result?.content).toContain('wb-controller')
    expect(tc.result?.isError).toBe(false)
  })

  test('parses ▶ format with err separator → isError=true', () => {
    const content = '▶ ssh_exec\n{"sn":"SN1"}\n— result err —\n{"error":"ECONNREFUSED"}'
    const items = turns([{ role: 'tool', toolCallId: undefined as any, content }])
    const tc = items[0] as any
    expect(tc.result?.isError).toBe(true)
    expect(tc.result?.content).toContain('ECONNREFUSED')
  })

  test('▶ format without result has no result field', () => {
    const content = '▶ ssh_exec\n{"sn":"SN1"}'
    const items = turns([{ role: 'tool', toolCallId: undefined as any, content }])
    const tc = items[0] as any
    expect(tc.result).toBeUndefined()
  })
})

describe('turnsToItems: assistant_file injection', () => {
  test('injects file item after tool_call with fileId result', () => {
    const fileResult = JSON.stringify({ fileId: 'abc123', fileName: 'photo.jpg', mime: 'image/jpeg', size: 1024 })
    const items = turns([
      { role: 'assistant', content: '', toolCalls: [{ id: 'c4', name: 'download_from_controller', arguments: '{}' }] },
      { role: 'tool', toolCallId: 'c4', content: fileResult },
    ])
    expect(items).toHaveLength(2)
    expect(items[1]).toMatchObject({ type: 'assistant_file', name: 'photo.jpg', mime: 'image/jpeg', size: 1024 })
  })
})

describe('turnsToItems: system turns', () => {
  test('skips system turns', () => {
    const items = turns([
      { role: 'system', content: 'you are a helpful assistant' },
      { role: 'user', content: 'hi' },
    ])
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ type: 'user' })
  })
})

// 🔧 N в подвале ассистент-сообщения. Цель — показать юзеру, что в стоимость
// рядом входят ВСЕ tool-итерации стрима, а не только финальный LLM-вызов с
// текстом. Счётчик перезагружается на каждом user-сообщении и каждом
// assistant_text — чтобы соседние стримы не сложились в один счётчик.
describe('turnsToItems: toolCallsCount on assistant_text', () => {
  test('zero when no tools precede the assistant_text', () => {
    const items = turns([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello back' },
    ])
    const at = items.find((i) => i.type === 'assistant_text') as any
    expect(at.toolCallsCount).toBe(0)
  })

  test('counts tools called between user and assistant_text', () => {
    const items = turns([
      { role: 'user', content: 'find controllers' },
      { role: 'assistant', content: '', toolCalls: [
        { id: 'c1', name: 'list_controllers', arguments: '{}' },
        { id: 'c2', name: 'probe_controller', arguments: '{"sn":"X"}' },
      ] },
      { role: 'tool', toolCallId: 'c1', content: '[]' },
      { role: 'tool', toolCallId: 'c2', content: 'ok' },
      { role: 'assistant', content: 'Found 1 controller.' },
    ])
    const finalText = items.find((i) => i.type === 'assistant_text') as any
    expect(finalText.toolCallsCount).toBe(2)
  })

  test('resets counter on each assistant_text', () => {
    const items = turns([
      { role: 'user', content: 'do many things' },
      { role: 'assistant', content: 'first', toolCalls: [
        { id: 'c1', name: 'a', arguments: '{}' },
        { id: 'c2', name: 'b', arguments: '{}' },
      ] },
      { role: 'tool', toolCallId: 'c1', content: 'r1' },
      { role: 'tool', toolCallId: 'c2', content: 'r2' },
      { role: 'assistant', content: 'final', toolCalls: [
        { id: 'c3', name: 'c', arguments: '{}' },
      ] },
      { role: 'tool', toolCallId: 'c3', content: 'r3' },
    ])
    const texts = items.filter((i) => i.type === 'assistant_text') as any[]
    expect(texts).toHaveLength(2)
    // "first" — 2 tool_call'а перед ним (c1, c2 в том же turn'е, но они уходят
    // в items раньше assistant_text согласно flow turnsToItems)
    expect(texts[0].toolCallsCount).toBe(2)
    // "final" — 1 tool_call между "first" и "final" (c3)
    expect(texts[1].toolCallsCount).toBe(1)
  })

  test('resets counter on user message — tools from previous stream do not leak', () => {
    const items = turns([
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'a', arguments: '{}' }] },
      { role: 'tool', toolCallId: 'c1', content: 'r' },
      { role: 'assistant', content: 'answer 1' },
      { role: 'user', content: 'q2' },
      { role: 'assistant', content: 'answer 2' },
    ])
    const texts = items.filter((i) => i.type === 'assistant_text') as any[]
    expect(texts).toHaveLength(2)
    expect(texts[0].toolCallsCount).toBe(1) // 1 инструмент перед "answer 1"
    expect(texts[1].toolCallsCount).toBe(0) // user q2 сбросил счётчик
  })
})
