import type { ChatTurn, AssistantToolCall } from './llm.ts'
import type { DbHandle } from './db.ts'

export type Chat = {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  contextSns: string[]
  turns: ChatTurn[]
  tokensPrompt: number
  tokensCompletion: number
}

const SYSTEM_PROMPT = `Ты — десктопный помощник интегратора Wiren Board, работающий на ноутбуке в локальной сети с контроллерами.

Возможности:
- видеть контроллеры, найденные через mDNS (паттерн wirenboard-<SN>.local), и добавленные вручную;
- работать с одним контроллером, выбранной группой или всеми сразу — это «контекст чата»;
- читать/писать MQTT (1883), список устройств и контролов, простая HTTP-проверка доступности;
- ходить по SSH на контроллер: выполнять команды, читать файлы, журнал systemd.

Правила:
- Если действие может затронуть несколько контроллеров — сначала кратко покажи план и попроси подтверждение, потом выполняй.
- Не выдумывай контроллеры/устройства — используй list_controllers / list_devices.
- Команды управления (mqtt_write на /on, ssh_exec) — только при явном запросе и явно перечисленных целях.
- Отвечай по-русски, кратко, по делу.`

type ChatRow = {
  id: string
  title: string
  created_at: number
  updated_at: number
  context_sns: string
  tokens_prompt: number
  tokens_completion: number
}

type TurnRow = {
  role: string
  content: string
  tool_call_id: string | null
  tool_calls: string | null
  tokens_prompt: number
  tokens_completion: number
}

export class ChatStore {
  constructor(private db: DbHandle) {}

  list(): Chat[] {
    const rows = this.db
      .query<ChatRow, []>(
        `SELECT c.id, c.title, c.created_at, c.updated_at, c.context_sns,
                COALESCE(SUM(t.tokens_prompt), 0) AS tokens_prompt,
                COALESCE(SUM(t.tokens_completion), 0) AS tokens_completion
           FROM chats c
           LEFT JOIN turns t ON t.chat_id = c.id
           GROUP BY c.id
           ORDER BY c.updated_at DESC`,
      )
      .all()
    return rows.map(rowToChatHeader)
  }

  get(id: string): Chat | undefined {
    const row = this.db
      .query<ChatRow, [string]>(
        `SELECT c.id, c.title, c.created_at, c.updated_at, c.context_sns,
                COALESCE((SELECT SUM(tokens_prompt) FROM turns WHERE chat_id = c.id), 0) AS tokens_prompt,
                COALESCE((SELECT SUM(tokens_completion) FROM turns WHERE chat_id = c.id), 0) AS tokens_completion
           FROM chats c WHERE c.id = ?`,
      )
      .get(id)
    if (!row) return
    const chat = rowToChatHeader(row)
    chat.turns = this.loadTurns(id)
    return chat
  }

  create(title?: string, contextSns: string[] = []): Chat {
    const id = crypto.randomUUID()
    const now = Date.now()
    this.db
      .query(
        `INSERT INTO chats (id, title, created_at, updated_at, context_sns)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, title ?? 'Новый чат', now, now, JSON.stringify(contextSns))
    this.appendTurn(id, { role: 'system', content: this.systemPromptFor(contextSns) })
    return this.get(id)!
  }

  rename(id: string, title: string): Chat | undefined {
    this.db
      .query(`UPDATE chats SET title = ?, updated_at = ? WHERE id = ?`)
      .run(title, Date.now(), id)
    return this.get(id)
  }

  setContext(id: string, sns: string[]): Chat | undefined {
    this.db
      .query(`UPDATE chats SET context_sns = ?, updated_at = ? WHERE id = ?`)
      .run(JSON.stringify(sns), Date.now(), id)
    // Update the leading system turn so the next LLM call sees the new context.
    const sys = this.db
      .query<{ id: number }, [string]>(
        `SELECT id FROM turns WHERE chat_id = ? ORDER BY ord ASC LIMIT 1`,
      )
      .get(id)
    if (sys) {
      this.db
        .query(`UPDATE turns SET content = ? WHERE id = ?`)
        .run(this.systemPromptFor(sns), sys.id)
    }
    return this.get(id)
  }

  remove(id: string) {
    this.db.query(`DELETE FROM chats WHERE id = ?`).run(id)
  }

  appendTurn(
    id: string,
    turn: ChatTurn,
    usage?: { promptTokens: number; completionTokens: number },
  ): Chat | undefined {
    const now = Date.now()
    const ord = this.nextOrd(id)
    const toolCalls =
      turn.role === 'assistant' && turn.toolCalls?.length ? JSON.stringify(turn.toolCalls) : null
    const toolCallId = turn.role === 'tool' ? turn.toolCallId : null
    const tokensPrompt = usage?.promptTokens ?? 0
    const tokensCompletion = usage?.completionTokens ?? 0
    this.db
      .query(
        `INSERT INTO turns (chat_id, ord, role, content, tool_call_id, tool_calls, tokens_prompt, tokens_completion, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, ord, turn.role, turn.content, toolCallId, toolCalls, tokensPrompt, tokensCompletion, now)
    this.db.query(`UPDATE chats SET updated_at = ? WHERE id = ?`).run(now, id)
    if (turn.role === 'user') this.maybeAutoTitle(id, turn.content)
    return this.get(id)
  }

  globalStats(): { totalPromptTokens: number; totalCompletionTokens: number } {
    const r = this.db
      .query<{ p: number; c: number }, []>(
        `SELECT COALESCE(SUM(tokens_prompt), 0) AS p, COALESCE(SUM(tokens_completion), 0) AS c FROM turns`,
      )
      .get()
    return { totalPromptTokens: r?.p ?? 0, totalCompletionTokens: r?.c ?? 0 }
  }

  systemPromptFor(sns: string[]): string {
    if (!sns.length) {
      return `${SYSTEM_PROMPT}\n\nКонтекст чата: контроллеры не выбраны. Если запрос требует конкретики — попроси выбрать контроллер(ы) или сделай list_controllers.`
    }
    return `${SYSTEM_PROMPT}\n\nКонтекст чата (выбранные контроллеры): ${sns.join(', ')}. По умолчанию все операции — на этих SN.`
  }

  private loadTurns(chatId: string): ChatTurn[] {
    const rows = this.db
      .query<TurnRow, [string]>(
        `SELECT role, content, tool_call_id, tool_calls, tokens_prompt, tokens_completion
           FROM turns WHERE chat_id = ? ORDER BY ord ASC`,
      )
      .all(chatId)
    return rows.map(rowToTurn)
  }

  private nextOrd(chatId: string): number {
    const r = this.db
      .query<{ next: number }, [string]>(
        `SELECT COALESCE(MAX(ord), -1) + 1 AS next FROM turns WHERE chat_id = ?`,
      )
      .get(chatId)
    return r?.next ?? 0
  }

  private maybeAutoTitle(chatId: string, content: string) {
    const r = this.db
      .query<{ n: number }, [string]>(
        `SELECT COUNT(*) AS n FROM turns WHERE chat_id = ? AND role = 'user'`,
      )
      .get(chatId)
    if ((r?.n ?? 0) === 1) {
      const title = content.trim().slice(0, 60) || 'Новый чат'
      this.db.query(`UPDATE chats SET title = ? WHERE id = ?`).run(title, chatId)
    }
  }
}

function rowToChatHeader(row: ChatRow): Chat {
  let ctx: string[] = []
  try { ctx = JSON.parse(row.context_sns) } catch {}
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    contextSns: ctx,
    turns: [],
    tokensPrompt: row.tokens_prompt,
    tokensCompletion: row.tokens_completion,
  }
}

function rowToTurn(row: TurnRow): ChatTurn {
  if (row.role === 'tool') {
    return { role: 'tool', toolCallId: row.tool_call_id ?? '', content: row.content }
  }
  if (row.role === 'assistant') {
    let toolCalls: AssistantToolCall[] | undefined
    if (row.tool_calls) {
      try { toolCalls = JSON.parse(row.tool_calls) } catch {}
    }
    const tokens = row.tokens_prompt || row.tokens_completion
      ? { tokensPrompt: row.tokens_prompt, tokensCompletion: row.tokens_completion }
      : {}
    return toolCalls?.length
      ? { role: 'assistant', content: row.content, toolCalls, ...tokens }
      : { role: 'assistant', content: row.content, ...tokens }
  }
  if (row.role === 'system') return { role: 'system', content: row.content }
  return { role: 'user', content: row.content }
}
