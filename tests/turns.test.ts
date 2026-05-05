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
