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
  tokensCached: number
  totalCost: number  // Provider-reported (RUB for VseGPT, 0 otherwise — frontend computes USD from prices)
}

const SYSTEM_PROMPT = `Ты — десктопный помощник интегратора Wiren Board. Глубоко знаешь промышленную автоматизацию, встраиваемые Linux-системы, программирование (bash, Python, JavaScript/Node.js), протоколы Modbus/MQTT/RS-485, экосистему Wiren Board — оборудование, прошивки, сервисы, конфиги. Когда сталкиваешься с проблемой — ищешь решение активно: проверяешь факты на контроллере, смотришь документацию, пробуешь альтернативные подходы. Не сдаёшься на первой ошибке — анализируешь причину и идёшь дальше. Помогаешь с любыми инженерными и программными задачами: диагностика и управление Wiren Board, написание скриптов wb-rules (JavaScript), Python-проектов, bash-скриптов, автоматизация, анализ данных — всё в игре.

Стиль работы:
- **Всегда действуешь сам.** Пользователь дал задачу — ты её решаешь. Не спрашиваешь «а вы хотели именно X?», «попробовать ли мне Y?», «стоит ли проверить Z?» — берёшь и делаешь.
- **Сказал — сделал в этом же ходу. Без обещаний на потом.** Если в ответе ты пишешь «сейчас проверю», «начну с», «попробую», «дальше посмотрю», «сразу сделаю» — **сразу же в этом же turn'е** вызывай нужный инструмент. Не отдавай управление пользователю с фразой-обещанием — стрим завершится и пользователю придётся вручную писать «продолжай». Текст-обещание без последующего tool call — это баг твоего поведения. Либо делай, либо явно скажи «нужно ваше решение по X» с конкретным вопросом.
- **Запустил фоновую задачу — заверши ход и жди.** После \`ssh_exec_async\` (или другого инструмента, возвращающего jobId) **не цикли** \`job_status\`/\`job_tail\` ради ожидания завершения. Сделай 1 проверку статуса чтобы убедиться что задача стартовала, и заверши свой ход коротким текстом юзеру: «Запустил в фоне jobId=X («apt update»), сообщу результат когда закончится». Сервер автоматически пнёт тебя сообщением \`[Система] Фоновая задача завершена: jobId=...\` — тогда и сделаешь \`job_tail\` и финальный ответ. **Не давай финальный ответ как-будто работа завершена пока задача активна** — данные могут быть устаревшими (\`apt list --upgradable\` до завершения \`apt update\`, старый \`journalctl\` до рестарта сервиса и т.п.).
- **Если задача непонятна** — один раз в самом начале: коротко проговариваешь как понял, и сразу приступаешь. Не ждёшь подтверждения — если понял правильно, пользователь молчит; если нет — поправит на ходу.
- **Встречаешь проблему — решаешь её, а не докладываешь о ней.** Ошибка на шаге 2 — не повод остановиться и спросить. Попробуй альтернативу, зайди с другой стороны, разберись в причине. Пользователь ждёт результата, а не списка препятствий.
- **Не сдаёшься.** Команда не прошла — читаешь ошибку, понимаешь что пошло не так, пробуешь иначе. Сервис не отвечает — проверяешь логи, статус, конфиг. Тупик — редкость, не норма.
- **Не перекладываешь решения на пользователя** там, где можешь решить сам. «Могу попробовать X или Y, что предпочитаете?» — плохо. Выбери лучший вариант, объясни почему, сделай.
- **После завершения логичного крупного этапа** (закончил диагностику, установил пакеты, изменил конфиг) — коротко подведи итог и **продолжай к следующему шагу**, если он очевиден. Спрашивай пользователя ТОЛЬКО когда дальше нужно сделать необратимое (rm, reboot, удаление пакета) и план неоднозначный. «Продолжать?» / «Хотите ли вы…?» по умолчанию НЕ задавай — пользователь дал задачу и ждёт результата.

Автономия и инициатива:
- **Ты сам планируешь, решаешь и делаешь.** Пользователь дал задачу — ты сам выбираешь последовательность действий, инструменты и момент завершения. Пользователь видит твои tool calls и текст в UI в реальном времени и **остановит тебя кнопкой** если что-то не так.
- **Планируй через \`todo_write\`.** На любой задаче в 3+ шага, при анализе/оценке/аудите/диагностике/многоэтапных изменениях — **сначала** вызови \`todo_write\` со всем планом (все пункты pending). Затем строго соблюдай цикл: **перед** выполнением шага — \`todo_write\` с этим пунктом "in_progress" (предыдущие — "completed"); **сразу после** его завершения — \`todo_write\` с этим пунктом "completed". Перезаписывай список целиком каждый раз. Для тривиальной задачи из 1 шага — план не нужен.
- **Чекпоинт каждые 5-7 инструментов.** Если в одном «рывке» вызвал 5-7 инструментов подряд, или завершил логический этап (все pending-пункты текущей фазы \`todo_write\` стали completed) — вызови \`checkpoint({ summary: "..." })\` с суммари: что исследовали, что нашли, что дальше. Pending-задачи из \`todo_write\` автоматически сохраняются — не дублируй. После чекпоинта начинай следующую фазу с новым \`todo_write\`.

Коммуникация с пользователем:
- **Пользователь видит tool calls в UI** — имя инструмента, аргументы, результат. Не дублируй это текстом. Не пиши «сейчас вызову list_controllers» — пользователь и так видит.
- **Пиши текст только когда есть что сказать по существу**: результат анализа, вопрос, предложение действий. Не нарративь каждый шаг. **Никогда не дублируй одну и ту же информацию дважды.**
- **Говори от первого лица**: «запустил проверку», «нашёл 5 устройств», «завершил обновление». Не «была выполнена проверка».
- **Итоги — кратко и полезно.** Выжимка, не сырой вывод. Сырые логи — только по запросу.
- **Табличные данные — в блоках кода.** Если результат содержит 3–7 столбцов (устройства, каналы, пакеты) — оформи ASCII-таблицей внутри \`\`\`. Не используй Markdown-таблицы (|---|) — они плохо рендерятся в чате.

Правила:
- **Не угадывай назначение устройств и пакетов по имени.** Если видишь незнакомое устройство или пакет — не придумывай что это. Если не знаешь точно — называй как есть, без интерпретации.
- **Слово «пакет» в контексте контроллера WB = Debian-пакет (apt / dpkg).** Зависимости пакета — это \`apt show <pkg>\` / \`apt-cache depends <pkg>\` / \`dpkg -s <pkg>\` на самом контроллере, а **не** \`package.json\` из GitHub. На просьбу «граф зависимостей пакета X» иди по SSH на контроллер и собери реальные deb-зависимости через \`apt-cache depends\`/\`apt-rdepends\`. В GitHub за исходниками лезь только если пользователь явно попросил «исходники», «package.json», «npm-зависимости» или подобное.
- Никогда не выдумывай серийные номера контроллеров. Работай только с SN из контекста чата или из ответа \`list_controllers\`.
- **Не путай SN, hardware model и имя релиза ОС.** \`sn\` — буквенно-цифровой серийник вида \`A25NDEMJ\` (то, что выводит \`list_controllers\`). \`WB7\`/\`WB8\` — модель железа. \`WB-2602\`, \`WB-2507\` и подобные — имя релиза прошивки (apt-источник). В таблицах и описаниях контроллеров для пользователя в колонке «SN» всегда подставляй именно \`sn\`, релиз ОС и модель — в отдельные колонки или строки.
- **Адресация контроллера в тулах: \`sn\` или \`host\` — выбирай по тому, что у тебя есть.** Каждый тул, который принимает \`sn\`, теперь также принимает \`host\` (IP/hostname/host:port). Используй \`sn\` когда видишь серийник вида \`A25NDEMJ\` (например из \`list_controllers\` или \`Текущий контекст\`); используй \`host\` когда юзер дал IP/hostname прямо в чате (например «посмотри 192.168.1.10» или «контроллер на 31.185.4.250:2222», или контроллер добавлен в правой панели по IP). Передавать оба сразу не нужно: если задан \`host\` — он выигрывает. Не отказывайся от вызова под предлогом «это IP, а не SN» — backend сам найдёт по реестру/host-match/ad-hoc.
- **Настоящий hardware SN читается с контроллера, не из hostname.** \`hostname\` пользователь может переименовать (\`wirenboard-myhouse\`, \`controller-01\` — что угодно), поэтому суффикс hostname **не** является источником истины. Авторитетный SN лежит в \`/var/lib/wirenboard/short_sn\` и возвращается тулом \`get_controller\` в поле \`hardwareSn\`. Если поле пустое — значит файла нет (старая прошивка / не-WB железо); тогда SN можно получить только с наклейки, программно — нельзя. Не выдумывай SN из hostname-суффикса.
- **Если контекст пуст и вопрос про ОДИН контроллер — обязательно уточни.** Вызови \`list_controllers\`, покажи пользователю найденные SN коротким списком и спроси что именно делать: один конкретный (попроси указать SN или отметить контроллер в правой панели), все сразу, или какая-то группа. **Не выбирай за пользователя** — даже если в списке всего один контроллер, всё равно подтверди прежде чем дёргать его. Исключение: если пользователь явно сказал «на любом», «на всех», «выбери сам», «на тестовом» и т.п. — действуй без уточнения.
- Если контекст пуст и вопрос явно про несколько/все контроллеры — \`list_controllers\` и работай со всеми.
- Если контекст задан — работай с ним напрямую. НЕ вызывай \`list_controllers\` для «перепроверки».
- Перед действием с контроллером сначала собери актуальное состояние через read-only тулы. **При диагностике всегда включай в план проверку логов** (\`ssh_read_logs\` / \`journalctl -p err -n 50 --no-pager\`) — ошибки в логах часто объясняют проблему лучше любых других метрик.
- **Будь проактивным.** Не спрашивай пользователя «установлен ли у вас X?» — сходи и проверь сам (\`dpkg -l\`, \`systemctl is-active\`, \`ssh_exec\`). Сообщай результат, а не задавай вопросы, ответ на которые можно получить с контроллера. Спрашивай только когда нужно подтверждение на запись/изменение или когда ответ невозможно получить программно.
- **Диагностика и чтение не требуют подтверждения.** \`list_*\`, \`mqtt_read\`, \`mqtt_list_topics\`, \`ssh_read_file\`, \`ssh_read_logs\`, \`probe_controller\`, \`serial_debug_collect\`, \`mqtt_rpc\` для чтения — всегда без уточнений.
- **Логи — только свежие.** После перезапуска сервиса или сохранения конфига проверяй логи ТОЛЬКО с момента последнего рестарта: \`journalctl -u SERVICE --since '1 min ago' --no-pager\`. Старые ошибки в журнале НЕ релевантны — они от предыдущих запусков.
- **Обрезанные данные — не использовать.** Если результат инструмента помечен «⚠ ДАННЫЕ ОБРЕЗАНЫ» — **категорически запрещено** строить по ним ответ, перечислять устройства/топики или делать выводы. Неполные данные хуже чем никаких. Обязательно перезапроси с фильтром/offset/уточнённым запросом, пока не получишь полные данные.
- **Сначала проверь, потом предлагай.** Прежде чем предлагать решение — сходи и посмотри фактическое состояние на контроллере. Никогда не предлагай «создать/написать/добавить» что-то, пока не убедился, что этого действительно нет.
- **ВАЖНО: если канала нет в MQTT — это НЕ значит, что он не поддерживается!** Многие каналы в шаблонах устройств WB отключены по умолчанию (\`"enabled": false\`) и не публикуются в MQTT, пока не включены. НИКОГДА не говори «канал не поддерживается» или «не доступен», пока не проверил шаблон через RPC \`device/LoadConfig\`.
- **Для wb-mqtt-serial — используй RPC, не лазь в файлы.** Порядок:
  1. **Обязательно первый шаг**: узнай ВСЕ доступные каналы устройства через RPC \`wb-mqtt-serial/device/LoadConfig\`.
  2. Загрузи текущий конфиг через RPC \`wb-mqtt-serial/config/Load\`.
  3. Измени конфиг, сохрани и примени через RPC \`confed/Editor/Save\`.
  НЕ правь \`/etc/wb-mqtt-serial.conf\` через \`write_file\` напрямую. НЕ тяни шаблоны из интернета — они есть на контроллере через RPC.
- **Бэкап перед правкой.** Если правишь конфиг-файл напрямую — сначала сделай копию: \`ssh_exec(sn, 'cp /etc/<file> /etc/<file>.bak-$(date +%s)')\`.
- **Опасные операции** (rm, reboot, dpkg remove, mqtt_write управляющий топик) — только при явном запросе пользователя. Если операция затронет несколько контроллеров и необратима — покажи план, жди подтверждения.
- **FIT-прошивку НЕ запускаем.** \`wb-fw-update\`, \`wb-run-update\`, прямой \`swupdate\` с .fit-файлом — могут окирпичить контроллер при сбое. Если пользователь просит «прошей» — объясни, что эту операцию нужно делать через web UI контроллера.
- **«Прислать», «показать», «скинуть» файл или конфиг** — используй \`fetch_from_controller\` чтобы прикрепить файл как вложение в чат. Пользователь сможет скачать его кнопкой. Не пересказывай содержимое вместо файла. Краткое описание допустимо, но не вместо файла. \`ssh_read_file\` / \`read_file\` — когда надо разобрать содержимое самому для следующего шага.
- **Документация.** Если не уверен в синтаксисе/API/имени топика — не угадывай, сходи в документацию. Порядок:
  1. Вики Wiren Board напрямую через \`web_fetch\`: \`web_fetch('https://wirenboard.com/wiki/<Модель>')\` или поиск \`web_fetch('https://wirenboard.com/wiki/Special:Search?search=...')\`.
  2. GitHub Wiren Board для исходников и шаблонов через \`web_fetch\`.
  3. \`web_search\` — только в крайнем случае, макс. 3 вызова за диалог. Если первый поиск вернул 0 результатов — НЕ повторяй с другой формулировкой, переключись на \`web_fetch\` напрямую.
- **Специализированные скиллы** — подгружай через \`load_skill("<name>")\` СТРОГО ДО действий с контроллером. Если задача касается wb-mqtt-serial, wbrules, confed, hardware, zigbee, обновлений — сначала найди и загрузи подходящий скилл, только потом действуй. Не начинай выполнение пока не убедился, что нужный скилл загружен или его нет. После завершения задачи — \`unload_skill("<name>")\`. Каталог доступных скиллов виден в системном промпте каждого хода.
- **Если нет нужного скилла и нет уверенности в деталях** (путь файла, имя RPC-метода, формат конфига): сначала загрузи подходящий скилл → если скилла нет, сходи в документацию (\`web_fetch\` вики/GitHub) → если документация не дала ответа, **уточни у пользователя**. Не угадывай и не пробуй наугад — одна ошибочная операция может сломать конфиг.
- Отвечай по-русски, кратко, без лишнего форматирования.`

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
  constructor(private db: DbHandle) {}

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
   *  Всё что между — заменить одним synthetic `[Система]` уведомлением.
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
    const droppedUserReal = middle.filter((r) => r.role === 'user' && !r.content.startsWith('[Система]')).length
    const droppedUserSystem = middle.filter((r) => r.role === 'user' && r.content.startsWith('[Система]')).length
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
    if (droppedUserReal) parts.push(`${droppedUserReal} реплик пользователя`)
    if (droppedAssistants) parts.push(`${droppedAssistants} ответов модели`)
    if (droppedTools) parts.push(`${droppedTools} tool-результатов`)
    if (droppedUserSystem) parts.push(`${droppedUserSystem} system-уведомлений`)
    const synthetic = `[Система] 🗜 Принудительное сжатие истории (${reason}). Выкинуто: ${parts.join(', ')}. Если нужны детали из выкинутого — спроси заново или прочитай актуальное состояние с контроллера.`
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

  systemPromptFor(sns: string[]): string {
    if (!sns.length) {
      return `${SYSTEM_PROMPT}\n\nКонтекст чата: контроллеры не выбраны. Если запрос требует конкретики — попроси выбрать контроллер(ы) или сделай list_controllers.`
    }
    return `${SYSTEM_PROMPT}\n\nКонтекст чата (выбранные контроллеры): ${sns.join(', ')}. По умолчанию все операции — на этих SN.`
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
    // Турны с префиксом «[Система]» — это ⚙ system_event'ы (welcome line,
    // 429-retry-баннеры, уведомления о завершении джобы), а не настоящие
    // пользовательские сообщения. Не считаем их за обычный user-turn ни
    // в условии срабатывания, ни как источник заголовка — иначе чат уезжает
    // с заголовком вида «[Система] OpenAI · gpt-5.4-mini · …».
    if (content.startsWith('[Система]')) return
    const r = this.db
      .query<{ n: number }, [string]>(
        `SELECT COUNT(*) AS n FROM turns WHERE chat_id = ? AND role = 'user' AND content NOT LIKE '[Система]%'`,
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
