# WB AI Helper — десктопный AI-помощник для Wiren Board

Один бинарник под Linux / Windows. Скачал → запустил → в браузере чат и список контроллеров, найденных в локальной сети по mDNS (`wirenboard-<SN>.local`). API-ключ LLM, MQTT- и SSH-креды задаются в UI и сохраняются рядом с бинарником.

Что умеет:
- ищет контроллеры в сети (mDNS, паттерн Wirenboard);
- работает с одним контроллером, выбранной группой или сразу со всеми;
- несколько чатов параллельно, каждый со своим контекстом контроллеров; история чатов и ручные контроллеры персистятся в SQLite;
- LLM с tool-calling (OpenAI-совместимый эндпоинт):
  - **MQTT**: список устройств и контролов, чтение/запись топиков на одном или группе сразу;
  - **HTTP**: пинг web-UI;
  - **SSH**: `ssh_exec`, `ssh_read_file`, `ssh_read_logs` (journalctl). Дефолт `root`/`wirenboard`, фоллбек: ключ → пароль;
- статистика токенов: по каждому сообщению, текущему чату и общий счётчик;
- список моделей подтягивается с сервера автоматически после ввода ключа;
- боковые панели чатов и контроллеров сворачиваются, освобождая место для чата;
- фронт встроен в бинарник, наружу только LLM и контроллеры (22 / 80 / 1883);
- кросс-платформа: Linux x64 и Windows x64, без установки.

## Использование

1. Скачать бинарник из `build/`:
   - Linux:   `wb-ai-helper-linux-x64`
   - Windows: `wb-ai-helper-windows-x64.exe`
2. Запустить. Браузер откроется автоматически на `http://127.0.0.1:17321/`.
3. При первом запуске откроется «Настройки» — вставить API-ключ → нажать «обновить список» → выбрать модель → «Сохранить».
4. Чат активен. Контроллеры появятся в правой колонке сами (если в сети есть mDNS).

Рядом с бинарником появятся:
- `wb-ai-helper-settings.json` — настройки (apiKey/sshPassword хранятся как plain JSON, файл с правами 600);
- `wb-ai-helper.db` — SQLite с чатами, сообщениями и ручными контроллерами.

Если в сети заблокирован mDNS — контроллер можно добавить вручную в правой колонке.

## Сборка (для разработчика)

Зависимости: [Bun](https://bun.sh) 1.3+. Node не требуется.

```bash
bun install
bun scripts/build.ts                    # один бинарник под текущую платформу
bun scripts/build.ts --all              # linux-x64 + windows-x64
bun scripts/build.ts --target=linux-x64 # явный таргет
```

Бинарники появятся в `build/`. Туда же копируется `README.txt`.

Smoke-проверка собранного бинарника (поднимает его, дёргает API, проверяет встроенный фронт):

```bash
bun scripts/smoke.ts
```

## Разработка

Два терминала:

```bash
# 1. бэкенд с hot-reload на :17321
bun run dev:server

# 2. vite-dev для фронта на :5173 с прокси /api → :17321
bun run dev:web
```

Открыть `http://127.0.0.1:5173/`.

## Архитектура

```
src/
├── server/                  Hono + Bun, всё в одном процессе
│   ├── index.ts             HTTP API + SSE, embed UI, открытие браузера
│   ├── settings.ts          settings.json + /v1/models
│   ├── db.ts                bun:sqlite, миграции, путь рядом с бинарём
│   ├── discovery.ts         mDNS-сканер (bonjour-service), фильтр wirenboard-*
│   ├── mqtt-pool.ts         пул MQTT-клиентов на контроллеры (mqtt.js)
│   ├── ssh.ts               пул SSH-клиентов (ssh2) + ssh_exec/read_file/read_logs
│   ├── http-probe.ts        HTTP-пинг web UI контроллера
│   ├── chats.ts             хранилище чатов в SQLite (chats / turns)
│   ├── llm.ts               OpenAI streaming + цикл tool-calling + сбор usage
│   ├── tools.ts             описания и обработчики инструментов
│   ├── embed.ts             отдача встроенных ассетов
│   └── embed-manifest.ts    AUTO-GENERATED, статические импорты файлов фронта
└── web/                     Vue 3, vite-сборка, чат-first
    ├── App.vue
    ├── api.ts               клиент API + SSE-парсер
    ├── utils.ts             общие утилиты (fmtTok и др.)
    └── components/
        ├── ChatList.vue     сворачиваемая левая панель
        ├── ChatPane.vue     чат + поле ввода
        ├── ControllerList.vue  сворачиваемая правая панель
        └── SettingsPanel.vue   модальные настройки
```

Под `bun build --compile` фронт пакуется в exe через `import('./web/dist/...', { with: { type: 'file' } })` — поэтому никаких файлов рядом нести не нужно, только сам бинарник. SQLite-файл и settings.json создаются при первом запуске.

## Аутентификация SSH

По умолчанию `root` / `wirenboard` (заводские креды Wirenboard). Можно переопределить в «Настройках»:

1. **Приватный ключ** — путь к файлу (например `~/.ssh/id_ed25519`). Используется первым.
2. **Пароль** — если ключ не подошёл (auth-fail) или не задан, идёт фоллбек на пароль (с keyboard-interactive поддержкой).

## Переменные окружения (необязательно)

Применяются только при первом запуске и сразу попадают в `wb-ai-helper-settings.json`. Дальше редактируются через UI.

```
OPENAI_API_KEY              стартовый ключ LLM
OPENAI_BASE_URL             свой эндпоинт (Azure / Ollama / vLLM / proxy)
OPENAI_MODEL                имя модели по умолчанию
WB_HELPER_PORT              порт UI (17321)
WB_HELPER_OPEN_BROWSER      0 чтобы не открывать браузер
WB_HELPER_DISCOVERY_INTERVAL  интервал mDNS-сканирования, мс
WB_HELPER_MQTT_USER         MQTT-логин
WB_HELPER_MQTT_PASSWORD     MQTT-пароль
WB_HELPER_SSH_USER          SSH-логин
WB_HELPER_SSH_PASSWORD      SSH-пароль
WB_HELPER_SSH_KEY           путь к приватному ключу
```

## Что специально не делается

- организационная иерархия / «облако» — выкинуто;
- мимикрия под WB Cloud — выкинуто;
- SFTP / async-jobs / wb-rules-конструктор — пока нет, можно сделать через `ssh_exec` если нужен какой-то конкретный сценарий.
