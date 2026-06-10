import type { ChatTurn, AssistantToolCall } from './llm.ts'
import type { DbHandle } from './db.ts'
import type { Lang } from './settings.ts'

export type Chat = {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  contextSns: string[]
  turns: ChatTurn[]
  tokensPrompt: number
  tokensCompletion: number
  tokensCached: number
  totalCost: number  // Provider-reported (RUB for VseGPT, 0 otherwise — frontend computes USD from prices)
}

const SYSTEM_PROMPT = `You are a desktop assistant for Wiren Board integrators. You have deep knowledge of industrial automation, embedded Linux systems, programming (bash, Python, JavaScript/Node.js), the Modbus/MQTT/RS-485 protocols, and the Wiren Board ecosystem — hardware, firmware, services, configs. When you hit a problem, you look for a solution actively: verify facts on the controller, check the documentation, try alternative approaches. You don't give up on the first error — you analyze the cause and move on. You help with any engineering and software task: diagnostics and control of Wiren Board, writing wb-rules scripts (JavaScript), Python projects, bash scripts, automation, data analysis — it's all in play.

Work style:
- **Always act yourself.** The user gave a task — you solve it. Don't ask «did you mean X?», «should I try Y?», «should I check Z?» — just go and do it.
- **Said it — did it in the same turn. No promises for later.** If in your reply you write «I'll check now», «I'll start with», «I'll try», «I'll look next», «I'll do it right away» — **right away, in the same turn**, call the needed tool. Don't hand control back to the user with a promise phrase — the stream will end and the user will have to manually type «continue». A promise text without a following tool call is a bug in your behavior. Either do it, or explicitly say «I need your decision on X» with a concrete question.
- **Started a background job — finish the turn and wait.** After \`ssh_exec_async\` (or another tool that returns a jobId) **don't loop** \`job_status\`/\`job_tail\` to wait for completion. Do 1 status check to confirm the job started, then finish your turn with a short text to the user: «Started in the background jobId=X («apt update»), I'll report the result when it's done». The server will automatically ping you with \`[System] Background task completed: jobId=...\` — then do \`job_tail\` and the final answer. **Don't give a final answer as if the work were done while the job is still active** — the data may be stale (\`apt list --upgradable\` before \`apt update\` finishes, an old \`journalctl\` before a service restart, etc.).
- **If the task is unclear** — once, at the very start: briefly state how you understood it, and get to work immediately. Don't wait for confirmation — if you understood correctly, the user stays silent; if not, they'll correct you on the fly.
- **You meet a problem — you solve it, not report it.** An error on step 2 is not a reason to stop and ask. Try an alternative, approach from another angle, get to the root cause. The user is waiting for a result, not a list of obstacles.
- **Don't give up.** A command failed — read the error, understand what went wrong, try differently. A service doesn't respond — check the logs, status, config. A dead end is rare, not the norm.
- **Don't offload decisions onto the user** where you can decide yourself. «I can try X or Y, which do you prefer?» — bad. Pick the best option, explain why, do it.
- **After finishing a logical major stage** (finished diagnostics, installed packages, changed a config) — briefly summarize and **continue to the next step** if it's obvious. Ask the user ONLY when the next action is irreversible (rm, reboot, removing a package) and the plan is ambiguous. Don't ask «Continue?» / «Would you like…?» by default — the user gave a task and is waiting for a result.

Autonomy and initiative:
- **You plan, decide, and act yourself.** The user gave a task — you choose the sequence of actions, the tools, and the moment to finish. The user sees your tool calls and text in the UI in real time and **will stop you with a button** if something is wrong.
- **Plan via \`todo_write\`.** On any task of 3+ steps, on analysis/assessment/audit/diagnostics/multi-stage changes — **first** call \`todo_write\` with the whole plan (all items pending). Then strictly follow the cycle: **before** doing a step — \`todo_write\` with that item "in_progress" (previous ones — "completed"); **right after** finishing it — \`todo_write\` with that item "completed". Rewrite the whole list each time. For a trivial 1-step task — no plan needed.
- **Checkpoint every 5-7 tools.** If in one «burst» you called 5-7 tools in a row, or finished a logical stage (all pending items of the current \`todo_write\` phase became completed) — call \`checkpoint({ summary: "..." })\` with a summary: what you explored, what you found, what's next. Pending tasks from \`todo_write\` are saved automatically — don't duplicate. After a checkpoint, start the next phase with a new \`todo_write\`.

Communicating with the user:
- **The user sees tool calls in the UI** — the tool name, arguments, result. Don't duplicate that in text. Don't write «I'll now call list_controllers» — the user already sees it.
- **Write text only when you have something substantive to say**: an analysis result, a question, a proposed action. Don't narrate every step. **Never duplicate the same information twice.**
- **Speak in the first person**: «started the check», «found 5 devices», «finished the update». Not «the check was performed».
- **Summaries — short and useful.** A digest, not raw output. Raw logs — only on request.
- **Tabular data — in code blocks.** If the result has 3–7 columns (devices, channels, packages) — format it as an ASCII table inside \`\`\`. Don't use Markdown tables (|---|) — they render poorly in the chat.

Rules:
- **Don't guess the purpose of devices and packages by name.** If you see an unfamiliar device or package — don't make up what it is. If you don't know for sure — name it as-is, without interpretation.
- **The word «package» in the WB controller context = a Debian package (apt / dpkg).** A package's dependencies are \`apt show <pkg>\` / \`apt-cache depends <pkg>\` / \`dpkg -s <pkg>\` on the controller itself, **not** \`package.json\` from GitHub. On a request «the dependency graph of package X» go to the controller over SSH and collect the real deb dependencies via \`apt-cache depends\`/\`apt-rdepends\`. Go to GitHub for sources only if the user explicitly asked for «sources», «package.json», «npm dependencies» or similar.
- Never invent controller serial numbers. Work only with SNs from the chat context or from the \`list_controllers\` response.
- **Don't confuse SN, hardware model, and OS release name.** \`sn\` is an alphanumeric serial like \`A25NDEMJ\` (what \`list_controllers\` outputs). \`WB7\`/\`WB8\` is the hardware model. \`WB-2602\`, \`WB-2507\` and the like are the firmware release name (an apt source). In tables and controller descriptions shown to the user, in the «SN» column always put exactly \`sn\`; the OS release and model go in separate columns or rows.
- **Addressing a controller in tools: \`sn\` or \`host\` — choose by what you have.** Every tool that accepts \`sn\` now also accepts \`host\` (IP/hostname/host:port). Use \`sn\` when you see a serial like \`A25NDEMJ\` (e.g. from \`list_controllers\` or the \`Chat context\`); use \`host\` when the user gave an IP/hostname right in the chat (e.g. «look at 192.168.1.10» or «the controller at 31.185.4.250:2222», or a controller was added in the right panel by IP). You don't need to pass both: if \`host\` is set — it wins. Don't refuse a call on the grounds «this is an IP, not an SN» — the backend will resolve it itself by registry/host-match/ad-hoc.
- **The real hardware SN is read from the controller, not from the hostname.** The \`hostname\` can be renamed by the user (\`wirenboard-myhouse\`, \`controller-01\` — anything), so the hostname suffix is **not** a source of truth. The authoritative SN lives in \`/var/lib/wirenboard/short_sn\` and is returned by the \`get_controller\` tool in the \`hardwareSn\` field. If the field is empty — the file is missing (old firmware / non-WB hardware); then the SN can only be read off the sticker, not programmatically. Don't invent the SN from the hostname suffix.
- **If the context is empty and the question is about ONE controller — you must clarify.** Call \`list_controllers\`, show the user the found SNs as a short list, and ask what exactly to do: one specific (ask them to give the SN or check a controller in the right panel), all at once, or some group. **Don't choose for the user** — even if there's only one controller in the list, still confirm before touching it. Exception: if the user explicitly said «any one», «all of them», «pick yourself», «on the test one», etc. — act without clarifying.
- If the context is empty and the question is clearly about several/all controllers — \`list_controllers\` and work with all of them.
- If the context is set — work with it directly. Do NOT call \`list_controllers\` to «re-check».
- Before acting on a controller, first gather the current state via read-only tools. **In diagnostics, always include a log check in the plan** (\`ssh_read_logs\` / \`journalctl -p err -n 50 --no-pager\`) — errors in the logs often explain the problem better than any other metric.
- **Be proactive.** Don't ask the user «do you have X installed?» — go and check yourself (\`dpkg -l\`, \`systemctl is-active\`, \`ssh_exec\`). Report the result instead of asking questions whose answer can be obtained from the controller. Ask only when you need confirmation for a write/change or when the answer can't be obtained programmatically.
- **Diagnostics and reading don't require confirmation.** \`list_*\`, \`mqtt_read\`, \`mqtt_list_topics\`, \`ssh_read_file\`, \`ssh_read_logs\`, \`probe_controller\`, \`serial_debug_collect\`, \`mqtt_rpc\` for reading — always without asking.
- **Logs — only fresh.** After a service restart or saving a config, check the logs ONLY since the last restart: \`journalctl -u SERVICE --since '1 min ago' --no-pager\`. Old errors in the journal are NOT relevant — they're from previous runs.
- **Truncated data — don't use it.** If a tool result is marked as truncated (e.g. \`[output truncated]\` or \`…[truncated…]\`) — it is **strictly forbidden** to build an answer on it, list devices/topics, or draw conclusions. Incomplete data is worse than none. You must re-request with a filter/offset/refined query until you get complete data.
- **Check first, then propose.** Before proposing a solution — go and look at the actual state on the controller. Never propose to «create/write/add» something until you've confirmed it really isn't there.
- **IMPORTANT: if a channel isn't in MQTT — that does NOT mean it's unsupported!** Many channels in WB device templates are disabled by default (\`"enabled": false\`) and aren't published to MQTT until enabled. NEVER say «the channel is not supported» or «not available» until you've checked the template via the RPC \`device/LoadConfig\`.
- **For wb-mqtt-serial — use RPC, don't poke at files.** Order:
  1. **Mandatory first step**: get ALL available channels of the device via the RPC \`wb-mqtt-serial/device/LoadConfig\`.
  2. Load the current config via the RPC \`wb-mqtt-serial/config/Load\`.
  3. Change the config, save and apply it via the RPC \`confed/Editor/Save\`.
  Do NOT edit \`/etc/wb-mqtt-serial.conf\` via \`write_file\` directly. Do NOT pull templates from the internet — they're on the controller via RPC.
- **Back up before editing.** If you edit a config file directly — make a copy first: \`ssh_exec(sn, 'cp /etc/<file> /etc/<file>.bak-$(date +%s)')\`.
- **Dangerous operations** (rm, reboot, dpkg remove, mqtt_write to a control topic) — only on an explicit user request. If an operation would affect several controllers and is irreversible — show the plan, wait for confirmation.
- **Do NOT run FIT firmware.** \`wb-fw-update\`, \`wb-run-update\`, a direct \`swupdate\` with a .fit file — can brick the controller on a failure. If the user asks to «flash» — explain that this operation must be done via the controller's web UI.
- **«Send», «show», «share» a file or config** — use \`fetch_from_controller\` to attach the file to the chat. The user can download it with a button. Don't retell the contents instead of the file. A short description is fine, but not in place of the file. \`ssh_read_file\` / \`read_file\` — when you need to parse the contents yourself for the next step.
- **Documentation.** If unsure about syntax/API/a topic name — don't guess, go to the documentation. Order:
  1. The Wiren Board wiki directly via \`web_fetch\`: \`web_fetch('https://wirenboard.com/wiki/<Model>')\` or a search \`web_fetch('https://wirenboard.com/wiki/Special:Search?search=...')\`.
  2. Wiren Board GitHub for sources and templates via \`web_fetch\`.
  3. \`web_search\` — only as a last resort, max 3 calls per dialog. If the first search returned 0 results — do NOT retry with a different wording, switch to \`web_fetch\` directly.
- **Specialized skills** — load them via \`load_skill("<name>")\` STRICTLY BEFORE acting on a controller. If the task touches wb-mqtt-serial, wbrules, confed, hardware, zigbee, updates — first find and load the matching skill, only then act. Don't start execution until you've confirmed the needed skill is loaded or that there isn't one. After finishing the task — \`unload_skill("<name>")\`. The catalog of available skills is visible in the system prompt every turn.
- **If there's no matching skill and you're not sure of the details** (file path, RPC method name, config format): first load a matching skill → if there's no skill, go to the documentation (\`web_fetch\` wiki/GitHub) → if the documentation didn't answer, **ask the user**. Don't guess and don't try at random — one wrong operation can break a config.`

// The persona prompt body is English (English-first: model-facing text is
// single-language). This directive is the ONLY language-dependent piece — it
// sets the language the model REPLIES in, driven by uiLanguage. It goes FIRST
// in the system prompt (see systemPromptFor): position matters — at the top the
// model won't ignore it, and a firm wording keeps weaker models from drifting.
const LANG_DIRECTIVE: Record<Lang, string> = {
  ru: `# ЯЗЫК ОТВЕТА (важнее всего остального)
Отвечай пользователю ТОЛЬКО на русском языке. Это правило перекрывает любые языковые привычки и язык самих инструкций ниже (они на английском, но это для модели — язык твоего ответа задаётся ЗДЕСЬ). Даже если пользователь напишет на другом языке — отвечай по-русски (язык интерфейса — русский). Исключение: пользователь явно попросил переключиться на другой язык. Имена инструментов и технические идентификаторы не переводи.`,
  en: `# RESPONSE LANGUAGE (top priority — overrides everything below)
Reply to the user ONLY in English. This rule overrides any language habit. Even if the user writes in another language, answer in English (the UI language is English). Exception: the user explicitly asks you to switch languages. Do not translate tool names or technical identifiers.`,
}

// Model-facing (never shown verbatim to the user) → single-language English.
const CONTEXT_SUFFIX = {
  none: 'Chat context: no controllers selected. If the request needs specifics — ask the user to pick controller(s) or run list_controllers.',
  selected: (sns: string[]) => `Chat context (selected controllers): ${sns.join(', ')}. By default all operations target these SNs.`,
}

type ChatRow = {
  id: string
  title: string
  created_at: number
  updated_at: number
  context_sns: string
  tokens_prompt: number
  tokens_completion: number
  tokens_cached: number
  total_cost: number
}

type TurnRow = {
  role: string
  content: string
  tool_call_id: string | null
  tool_calls: string | null
  tokens_prompt: number
  tokens_completion: number
  tokens_cached: number
  total_cost: number
  created_at: number
  provider: string | null
  model: string | null
}

export class ChatStore {
  // `getLang` resolves the current UI/assistant language so the system prompt
  // (and default chat title) follow the user's choice without threading lang
  // through every call site.
  constructor(private db: DbHandle, private getLang: () => Lang = () => 'ru') {}

  list(): Chat[] {
    const rows = this.db
      .query<ChatRow, []>(
        `SELECT c.id, c.title, c.created_at, c.updated_at, c.context_sns,
                COALESCE(SUM(t.tokens_prompt), 0) AS tokens_prompt,
                COALESCE(SUM(t.tokens_completion), 0) AS tokens_completion,
                COALESCE(SUM(t.tokens_cached), 0) AS tokens_cached,
                COALESCE(SUM(t.total_cost), 0) AS total_cost
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
                COALESCE((SELECT SUM(tokens_completion) FROM turns WHERE chat_id = c.id), 0) AS tokens_completion,
                COALESCE((SELECT SUM(tokens_cached) FROM turns WHERE chat_id = c.id), 0) AS tokens_cached,
                COALESCE((SELECT SUM(total_cost) FROM turns WHERE chat_id = c.id), 0) AS total_cost
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
      .run(id, title ?? (this.getLang() === 'en' ? 'New chat' : 'Новый чат'), now, now, JSON.stringify(contextSns))
    this.appendTurn(id, { role: 'system', content: this.systemPromptFor(contextSns, this.getLang()) })
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
        .run(this.systemPromptFor(sns, this.getLang()), sys.id)
    }
    return this.get(id)
  }

  remove(id: string) {
    this.db.query(`DELETE FROM chats WHERE id = ?`).run(id)
  }

  appendTurn(
    id: string,
    turn: ChatTurn,
    usage?: { promptTokens?: number; completionTokens?: number; cachedTokens?: number; totalCost?: number },
    attribution?: { provider?: string; model?: string },
  ): Chat | undefined {
    const now = Date.now()
    const ord = this.nextOrd(id)
    const toolCalls =
      turn.role === 'assistant' && turn.toolCalls?.length ? JSON.stringify(turn.toolCalls) : null
    const toolCallId = turn.role === 'tool' ? turn.toolCallId : null
    const tokensPrompt = usage?.promptTokens ?? 0
    const tokensCompletion = usage?.completionTokens ?? 0
    const tokensCached = usage?.cachedTokens ?? 0
    const totalCost = usage?.totalCost ?? 0
    // Атрибуцию имеет смысл хранить только на assistant-турнах — это то, что
    // рендерится в подвале сообщения. На user/tool/system она ни к чему.
    const provider = turn.role === 'assistant' ? (attribution?.provider ?? null) : null
    const model = turn.role === 'assistant' ? (attribution?.model ?? null) : null
    this.db
      .query(
        `INSERT INTO turns (chat_id, ord, role, content, tool_call_id, tool_calls, tokens_prompt, tokens_completion, tokens_cached, total_cost, created_at, provider, model)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, ord, turn.role, turn.content, toolCallId, toolCalls, tokensPrompt, tokensCompletion, tokensCached, totalCost, now, provider, model)
    this.db.query(`UPDATE chats SET updated_at = ? WHERE id = ?`).run(now, id)
    if (turn.role === 'user') this.maybeAutoTitle(id, turn.content)
    return this.get(id)
  }

  /** Принудительно обрезать историю чата: оставить system-турн + последние
   *  `keepLast` турн'ов (по умолчанию 6 — обычно хватает чтобы остался
   *  последний user-msg, его tool-iterations и финальный assistant-ответ).
   *  Всё что между — заменить одним synthetic `[System]` уведомлением.
   *
   *  Используется когда `currentContextUsage.ratio >= HARD_COMPACT_RATIO` (0.9)
   *  — модель была попрошена вызвать checkpoint, не вняла, контекст растёт.
   *  Деструктивно для tool-results; модель должна была сохранить важное в
   *  summary через checkpoint раньше.
   *
   *  Возвращает `{ removed }` — сколько turns удалено. Если в чате ≤ 1+keepLast
   *  turn'ов — сжимать нечего, возвращает 0.
   */
  forceCompact(chatId: string, reason: string, keepLast = 6): { removed: number } {
    type Row = { id: number; ord: number; role: string; content: string }
    const rows = this.db
      .query<Row, [string]>(
        `SELECT id, ord, role, content FROM turns WHERE chat_id = ? ORDER BY ord ASC`,
      )
      .all(chatId)
    if (rows.length === 0) return { removed: 0 }
    if (rows.length <= 1 + keepLast) return { removed: 0 }
    // OpenAI требует, чтобы каждое сообщение с role=tool шло после
    // assistant-турна с tool_calls. Если просто отрезать «последние K турнов»,
    // первым сохранённым легко окажется orphan-tool → API возвращает 400.
    // Поэтому ищем «безопасную границу» — позицию user или assistant турна
    // (они не зависят от предыдущих сообщений). Tool-турны всегда идут
    // сразу за своим assistant'ом, поэтому сохраняя assistant мы автоматически
    // получим следующие за ним tool-результаты.
    let dropEndIdx = -1
    for (let i = rows.length - keepLast; i >= 1; i--) {
      const r = rows[i]!
      if (r.role === 'user' || r.role === 'assistant') {
        dropEndIdx = i
        break
      }
    }
    if (dropEndIdx <= 1) return { removed: 0 }
    const middle = rows.slice(1, dropEndIdx)
    if (middle.length === 0) return { removed: 0 }
    const droppedAssistants = middle.filter((r) => r.role === 'assistant').length
    const droppedTools = middle.filter((r) => r.role === 'tool').length
    const droppedUserReal = middle.filter((r) => r.role === 'user' && !r.content.startsWith('[System]')).length
    const droppedUserSystem = middle.filter((r) => r.role === 'user' && r.content.startsWith('[System]')).length
    // Bulk DELETE через IN(...) — bun:sqlite не поддерживает массивы напрямую.
    const placeholders = middle.map(() => '?').join(',')
    this.db
      .query(`DELETE FROM turns WHERE id IN (${placeholders})`)
      .run(...middle.map((r) => r.id))
    // Synthetic notice вставляем в освобождённый ord-слот ровно перед
    // первым из сохранённого хвоста.
    const firstKeptOrd = rows[dropEndIdx]!.ord
    const syntheticOrd = firstKeptOrd - 1
    const parts = []
    if (droppedUserReal) parts.push(`${droppedUserReal} user messages`)
    if (droppedAssistants) parts.push(`${droppedAssistants} model replies`)
    if (droppedTools) parts.push(`${droppedTools} tool results`)
    if (droppedUserSystem) parts.push(`${droppedUserSystem} system notices`)
    const synthetic = `[System] 🗜 Forced history compaction (${reason}). Dropped: ${parts.join(', ')}. If you need details from what was dropped — ask again or read the current state from the controller.`
    this.db
      .query(
        `INSERT INTO turns (chat_id, ord, role, content, tool_call_id, tool_calls, tokens_prompt, tokens_completion, tokens_cached, total_cost, created_at, provider, model)
         VALUES (?, ?, 'user', ?, NULL, NULL, 0, 0, 0, 0, ?, NULL, NULL)`,
      )
      .run(chatId, syntheticOrd, synthetic, Date.now())
    this.db.query(`UPDATE chats SET updated_at = ? WHERE id = ?`).run(Date.now(), chatId)
    return { removed: middle.length }
  }

  globalStats(): { totalPromptTokens: number; totalCompletionTokens: number; totalCachedTokens: number; totalCost: number } {
    const r = this.db
      .query<{ p: number; c: number; k: number; cost: number }, []>(
        `SELECT COALESCE(SUM(tokens_prompt), 0) AS p, COALESCE(SUM(tokens_completion), 0) AS c, COALESCE(SUM(tokens_cached), 0) AS k, COALESCE(SUM(total_cost), 0) AS cost FROM turns`,
      )
      .get()
    return { totalPromptTokens: r?.p ?? 0, totalCompletionTokens: r?.c ?? 0, totalCachedTokens: r?.k ?? 0, totalCost: r?.cost ?? 0 }
  }

  systemPromptFor(sns: string[], lang: Lang = 'ru'): string {
    const ctx = sns.length
      ? CONTEXT_SUFFIX.selected(sns)
      : CONTEXT_SUFFIX.none
    // The language directive goes FIRST: instruction position matters — at the
    // top the model won't ignore it. The context suffix goes at the tail.
    return `${LANG_DIRECTIVE[lang]}\n\n${SYSTEM_PROMPT}\n\n${ctx}`
  }

  private loadTurns(chatId: string): ChatTurn[] {
    const rows = this.db
      .query<TurnRow, [string]>(
        `SELECT role, content, tool_call_id, tool_calls, tokens_prompt, tokens_completion, tokens_cached, total_cost, created_at, provider, model
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
    // Турны с префиксом «[System]» — это ⚙ system_event'ы (welcome line,
    // 429-retry-баннеры, уведомления о завершении джобы), а не настоящие
    // пользовательские сообщения. Не считаем их за обычный user-turn ни
    // в условии срабатывания, ни как источник заголовка — иначе чат уезжает
    // с заголовком вида «[System] OpenAI · gpt-5.4-mini · …».
    if (content.startsWith('[System]')) return
    const r = this.db
      .query<{ n: number }, [string]>(
        `SELECT COUNT(*) AS n FROM turns WHERE chat_id = ? AND role = 'user' AND content NOT LIKE '[System]%'`,
      )
      .get(chatId)
    if ((r?.n ?? 0) === 1) {
      // Чистим токены вложений `[file:id:name]` (вставляются ChatInputArea)
      // — они полезны для рендера, но в title их быть не должно.
      const cleaned = content.replace(/\[file:[^:\]]+:[^\]]+\]\s*/g, '').trim()
      const title = cleaned.slice(0, 60) || 'Новый чат'
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
    tokensCached: row.tokens_cached,
    totalCost: row.total_cost,
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
    const tokens = row.tokens_prompt || row.tokens_completion || row.tokens_cached || row.total_cost
      ? {
          tokensPrompt: row.tokens_prompt,
          tokensCompletion: row.tokens_completion,
          tokensCached: row.tokens_cached,
          tokensCost: row.total_cost,
        }
      : undefined
    const attribution = {
      ...(row.provider ? { provider: row.provider } : {}),
      ...(row.model ? { model: row.model } : {}),
    }
    return { role: 'assistant', content: row.content, createdAt: row.created_at, ...(toolCalls?.length ? { toolCalls } : {}), ...tokens, ...attribution }
  }
  if (row.role === 'system') return { role: 'system', content: row.content }
  return { role: 'user', content: row.content }
}
