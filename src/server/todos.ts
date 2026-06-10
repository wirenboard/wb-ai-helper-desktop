/**
 * Per-session todo list. In-memory — the plan lives within the session.
 * The model writes the whole list via todo_write. The list is injected as a
 * system message on every turn.
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
  if (!items.length) return '(plan is empty)'
  const mark: Record<TodoStatus, string> = { pending: '[ ]', in_progress: '[~]', completed: '[x]' }
  return items.map((t, i) => `${i + 1}. ${mark[t.status]} ${t.content}`).join('\n')
}
