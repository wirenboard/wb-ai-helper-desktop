import { describe, test, expect, afterEach } from 'bun:test'
import { getTodos, setTodos, clearTodos, formatTodos, type TodoItem } from '../src/server/todos.ts'

afterEach(() => {
  clearTodos('s1')
  clearTodos('s2')
})

describe('getTodos / setTodos', () => {
  test('returns empty for unknown session', () => {
    expect(getTodos('unknown')).toEqual([])
  })

  test('round-trip', () => {
    const items: TodoItem[] = [{ content: 'do X', status: 'pending' }]
    setTodos('s1', items)
    expect(getTodos('s1')).toEqual(items)
  })

  test('empty array deletes session', () => {
    setTodos('s1', [{ content: 'x', status: 'pending' }])
    setTodos('s1', [])
    expect(getTodos('s1')).toEqual([])
  })

  test('sessions are independent', () => {
    setTodos('s1', [{ content: 'a', status: 'pending' }])
    setTodos('s2', [{ content: 'b', status: 'completed' }])
    expect(getTodos('s1')).toHaveLength(1)
    expect(getTodos('s2')).toHaveLength(1)
    expect(getTodos('s1')[0]?.content).toBe('a')
  })
})

describe('clearTodos', () => {
  test('removes session data', () => {
    setTodos('s1', [{ content: 'x', status: 'pending' }])
    clearTodos('s1')
    expect(getTodos('s1')).toEqual([])
  })

  test('no-op for unknown session', () => {
    clearTodos('nonexistent') // should not throw
  })
})

describe('formatTodos', () => {
  test('empty list', () => {
    expect(formatTodos([])).toBe('(план пуст)')
  })

  test('renders statuses correctly', () => {
    const items: TodoItem[] = [
      { content: 'task A', status: 'pending' },
      { content: 'task B', status: 'in_progress' },
      { content: 'task C', status: 'completed' },
    ]
    const result = formatTodos(items)
    expect(result).toBe('1. [ ] task A\n2. [~] task B\n3. [x] task C')
  })

  test('numbers start from 1', () => {
    const items: TodoItem[] = [{ content: 'only', status: 'pending' }]
    expect(formatTodos(items)).toStartWith('1.')
  })
})
