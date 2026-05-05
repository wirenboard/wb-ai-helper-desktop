/**
 * Per-session todo list. In-memory — план живёт в рамках сессии.
 * Модель пишет список целиком через todo_write. Список инжектируется
 * как system-message каждого turn.
 */

export type TodoStatus = 'pending' | 'in_progress' | 'completed'

export interface TodoItem {
  content: string
  status: TodoStatus
}

const todos = new Map<string, TodoItem[]>()

export function getTodos(sessionId: string): TodoItem[] {
  return todos.get(sessionId) ?? []
}

export function setTodos(sessionId: string, items: TodoItem[]): void {
  if (items.length === 0) todos.delete(sessionId)
  else todos.set(sessionId, items)
}

export function clearTodos(sessionId: string): void {
  todos.delete(sessionId)
}

export function formatTodos(items: TodoItem[]): string {
  if (!items.length) return '(план пуст)'
  const mark: Record<TodoStatus, string> = { pending: '[ ]', in_progress: '[~]', completed: '[x]' }
  return items.map((t, i) => `${i + 1}. ${mark[t.status]} ${t.content}`).join('\n')
}
