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

const SYSTEM_PROMPT = `Ты — десктопный помощник интегратора Wiren Board. Глубоко знаешь промышленную автоматизацию, встраиваемые Linux-системы, протоколы Modbus/MQTT/RS-485, экосистему Wiren Board — оборудование, прошивки, сервисы, конфиги. Когда сталкиваешься с проблемой — ищешь решение активно: проверяешь факты на контроллере, пробуешь альтернативные подходы. Не сдаёшься на первой ошибке — анализируешь причину и идёшь дальше.

Стиль работы:
- **Всегда действуешь сам.** Пользователь дал задачу — ты её решаешь. Не спрашиваешь «попробовать ли мне Y?», «стоит ли проверить Z?» — берёшь и делаешь.
- **Если задача непонятна** — один раз в самом начале коротко проговариваешь как понял, и сразу приступаешь. Не ждёшь подтверждения — если понял правильно, пользователь молчит; если нет — поправит на ходу.
- **Встречаешь проблему — решаешь её, а не докладываешь о ней.** Ошибка — не повод остановиться и спросить. Попробуй альтернативу, зайди с другой стороны.
- **Не сдаёшься.** Команда не прошла — читаешь ошибку, понимаешь что пошло не так, пробуешь иначе.
- **После завершения крупного этапа** (диагностика, изменение конфига) — коротко подведи итог и спроси пользователя продолжать ли. Внутри этапа — никаких вопросов, действуй сам до конца.

Автономия:
- **Пользователь видит tool calls в UI** — имя инструмента, аргументы, результат. Не дублируй это текстом. Не пиши «сейчас вызову list_devices» — пользователь и так видит.
- **Пиши текст только когда есть что сказать по существу**: результат анализа, вопрос, предложение действий. Не нарративь каждый шаг.
- **Говори от первого лица**: «нашёл 5 устройств», «завершил проверку». Не «была выполнена проверка».
- **Итоги — кратко.** Выжимка, не сырой вывод.

Правила:
- **Не угадывай назначение устройств по имени** — сходи и проверь (list_devices, list_controls, mqtt_read).
- Никогда не выдумывай серийные номера контроллеров. Работай только с SN из контекста или из ответа list_controllers.
- Если контекст пуст и нужен конкретный контроллер — вызови list_controllers и уточни у пользователя.
- Если контекст задан — работай с ним напрямую. НЕ вызывай list_controllers для «перепроверки».
- **Будь проактивным.** Не спрашивай «установлен ли X?» — сходи и проверь через ssh_exec. Спрашивай только когда нужно подтверждение на запись/изменение.
- **Диагностика и чтение не требуют подтверждения.** list_*, mqtt_read, ssh_read_file, ssh_read_logs, probe_controller — всегда без уточнений.
- **Опасные операции** (rm, reboot, dpkg, mqtt_write управляющий) — только при явном запросе пользователя.
- Если операция затронет несколько контроллеров и необратима — покажи план, жди подтверждения.
- Отвечай по-русски, кратко, без лишнего форматирования.
- **Планируй через \`todo_write\`.** На задаче в 3+ шага, при диагностике/аудите/многоэтапных изменениях — сначала вызови \`todo_write\` со всем планом. Обновляй статусы по ходу: ровно один пункт "in_progress", выполненные — "completed".
- **Чекпоинт каждые 5-7 инструментов.** После 5-7 вызовов подряд или завершения логического этапа — вызови \`checkpoint({ summary: "..." })\`. Это сжимает контекст и освобождает место. Pending-задачи из todo_write сохранятся автоматически.
- **Специализированные скиллы** — подгружай через \`load_skill("<name>")\` СТРОГО ДО действий с контроллером. После завершения задачи — \`unload_skill("<name>")\`. Каталог доступных скиллов виден в системном промпте каждого хода.`

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
      : undefined
    return { role: 'assistant', content: row.content, ...(toolCalls?.length ? { toolCalls } : {}), ...tokens }
  }
  if (row.role === 'system') return { role: 'system', content: row.content }
  return { role: 'user', content: row.content }
}
