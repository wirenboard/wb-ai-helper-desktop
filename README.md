# WB AI Helper — десктопный AI-помощник для Wiren Board

> **Прототип / экспериментальный проект.**
> Ранняя версия для внутреннего тестирования, не готовая к использованию в критичных production-средах.
> Инструмент имеет прямой доступ к контроллерам через MQTT и SSH — включая запись топиков, выполнение произвольных команд и фоновые задачи через `systemd-run`. Используйте осознанно и на собственный страх и риск.

![Главное окно](docs/screenshots/main.png)

Один бинарник под Linux / Windows + AppImage для Linux desktop. Скачал → запустил → встроенное окно Chrome открывается с чатом и списком контроллеров, найденных в локальной сети по mDNS (`wirenboard-<SN>.local`). LLM-ключи, MQTT- и SSH-креды задаются в UI и сохраняются в `~/.config/wb-ai-helper/` (или рядом с бинарником в standalone-режиме).

## Быстрый старт

1. **Скачать сборку под свою ОС** из [Releases](../../releases/latest):
   - Linux desktop: `WB-AI-Helper-x86_64.AppImage` (всё-в-одном с UI)
   - Linux CLI / сервер: `wb-ai-helper-linux-x64`
   - Windows: `wb-ai-helper-windows-x64.exe`
2. **Получить API-ключ** у любого OpenAI-совместимого провайдера:
   - **OpenAI** — [platform.openai.com/api-keys](https://platform.openai.com/api-keys); пополнить баланс через credit card. Дешёвая модель — `gpt-4o-mini`
   - **Self-hosted** — Ollama / LiteLLM / vLLM на своём сервере, ключ необязателен
   - **Корпоративный/MITM-прокси** с OpenAI-совместимым endpoint (Copilot и т.п.) — Custom AI Proxy с CA-сертификатом (см. ниже)
3. **Запустить и настроить:**
   - `chmod +x ./WB-AI-Helper-x86_64.AppImage && ./WB-AI-Helper-x86_64.AppImage`
   - В шапке открыть «Настройки» (⚙)
   - Выбрать провайдера → вставить ключ → нажать «обновить список» → выбрать модель → «Сохранить»
4. Контроллеры в правой колонке появятся сами через mDNS. Если в сети закрыт mDNS — добавь вручную по hostname/IP.
5. Чат активен. Например: «что подключено на шине RS-485?», «пришли график температуры процессора со вчерашнего дня».

## Что умеет

**Поиск и работа с контроллерами:**
- **mDNS-сканер сети** — автоматически находит контроллеры по паттерну `wirenboard-<SN>.local`. Список обновляется на лету каждые ~15 секунд. Если в сети закрыт mDNS, контроллер можно добавить вручную по hostname или IP
- **Web UI прямо из приложения** — клик по 🌐 в карточке контроллера открывает его web-интерфейс в новой вкладке
- **Встроенный SSH-терминал** — клик по ▷_ открывает выезжающую снизу панель с xterm.js, поверх ssh2-сессии. Все горячие клавиши, цвета, ANSI escape работают
- Несколько чатов параллельно, каждый со своим контекстом контроллеров (один / выбранная группа / все)
- Кнопка пере-сканирования сети, ручное удаление неактуальных записей

**LLM с tool-calling:**
- 4 группы провайдеров в настройках:
  - **OpenAI** — прямой доступ к `api.openai.com`
  - **Custom** — произвольный OpenAI-совместимый endpoint (Ollama, LiteLLM, vLLM…)
  - **Custom AI Proxy** — endpoint за MITM-прокси с CA-сертификатом (только OpenAI Chat Completions, например Copilot через прокси)
  - Каждый профиль помнит свой ключ/baseURL/model/прокси/CA — переключаются мгновенно
- ~50 инструментов: `mqtt_*`, `ssh_*`, `wb_bus_scan`, `serial_debug_collect`, `audit_controller`, `get_history`/`get_history_chart` (графики через vega-lite — line/bar/area/point/histogram/heatmap/boxplot), `fetch_from_controller`/`upload_to_controller`, `save_rule`/`load_rule`/`delete_rule` (wb-rules через `wbrules/Editor`)
- Скиллы (17 шт. в `src/server/fixtures/skills/`) — `controller-backup`, `controller-update`, `wb-mqtt-serial`, `wb-rules`, `troubleshooting-*`, `diagrams`, `history` и т.д. — подгружаются по запросу через `load_skill`
- Фоновые задачи (`ssh_exec_async`, `wb_bus_scan`, `serial_debug_collect`) — запуск через `systemd-run` на контроллере, инлайн-индикатор в чате с обратной отменой (5 сек undo через «продолжить»)
- Аттачменты: пользовательские (через 📎) и созданные моделью (`fetch_from_controller`/`get_history_chart`) разделены на бэке (`source: 'user'|'assistant'`) — модель не получает свои файлы обратно
- Стоимость считается per-сообщение: USD/1M токенов для OpenAI, в Custom/Proxy скрыта (только токены)
- Время сообщения и провайдер/модель — в футере каждого ответа

**UI/UX:**
- Сворачиваемые боковые панели (чаты слева, контроллеры справа)
- Поиск по моделям (typeahead)
- Удаление чата + «удалить все» с 5-сек undo
- Экспорт/импорт настроек в JSON (включая ключи и CA)
- Тёмная/светлая/авто-тема, регулировка размера шрифта
- Файл фронта встроен в бинарник, наружу только LLM (через прокси если задан) и контроллеры (22 / 80 / 1883)

## Где хранятся данные

- **AppImage / dev**: `~/.config/wb-ai-helper/` (Linux/XDG) или `%APPDATA%\wb-ai-helper\` (Windows) — `settings.json`, `wb-ai-helper.db` (SQLite, чаты+история), `attachments/<chatId>/` (вложения)
- **Standalone-бинарник**: эти же файлы создаются рядом с бинарником

## Сборка

Зависимости: [Bun](https://bun.sh) 1.3+ (Node не требуется), для AppImage — `appimagetool` в `$PATH` или `/tmp/appimagetool`.

```bash
bun install
bun scripts/build.ts                    # бинарник под текущую платформу
bun scripts/build.ts --all              # linux-x64 + windows-x64
bun scripts/build.ts --target=linux-x64 # явный таргет
bun scripts/build-appimage.ts           # AppImage из linux-x64 (нужно собрать бинарник до этого)
bun scripts/smoke.ts                    # smoke-тест собранного бинаря
bun run typecheck                       # tsc + vue-tsc
```

Бинарники появятся в `build/`.

## Разработка

```bash
# 1. бэкенд с hot-reload на :17321
bun run dev:server

# 2. vite-dev для фронта на :5173 с прокси /api → :17321
bun run dev:web
```

Открыть `http://127.0.0.1:5173/`. В dev-режиме settings.json и БД лежат в `~/.config/wb-ai-helper/`.

## Архитектура (кратко)

```
src/
├── server/                  Bun + Hono, всё в одном процессе
│   ├── index.ts             Bun.serve: HTTP + SSE + WebSocket (SSH-терминал)
│   ├── settings.ts          per-provider profiles, CA-cert inline (PEM в JSON)
│   ├── llm.ts               OpenAI streaming, агентный цикл (до 20 turns)
│   ├── tools.ts             ~50 инструментов: mqtt/ssh/discovery/history/wb-rules
│   ├── history-chart.ts     рендер графиков через vega-lite SSR (line/bar/heatmap/...)
│   ├── jobs.ts              трекер фоновых SSH-задач (in-memory)
│   ├── attachments.ts       файлы с тегом source='user'|'assistant'
│   ├── chats.ts             SQLite-хранилище chats/turns + системный промт (RU)
│   ├── skills.ts            каталог + загрузка скиллов в контекст LLM
│   ├── ssh.ts               пул ssh2-клиентов, exec/jobStart/openShell, SFTP
│   ├── mqtt-pool.ts         пул mqtt.js-клиентов
│   ├── discovery.ts         mDNS/avahi-browse сканер
│   ├── db.ts                bun:sqlite WAL + миграции
│   └── fixtures/skills/     17 markdown-скиллов
└── web/                     Vue 3, Vite, без UI-фреймворка
    ├── App.vue              корневой layout
    ├── api.ts               клиент API + типы
    ├── components/
    │   ├── ChatList.vue                Левый сайдбар (чаты + delete-all undo)
    │   ├── ChatPane.vue                Чат + поле ввода
    │   ├── ChatMessageList.vue         Список сообщений + инлайн-job
    │   ├── ChatMessage.vue             Один баббл (markdown + mermaid + hljs + файлы)
    │   ├── ChatInputArea.vue           Текст + аттачи + drag-drop
    │   ├── ControllerList.vue          Правый сайдбар + Web UI/Terminal иконки
    │   ├── SettingsPanel.vue           Провайдеры, ключи, CA-cert, цены, экспорт/импорт
    │   ├── ComboboxSearch.vue          Typeahead-выбор моделей
    │   └── SshTerminal.vue             xterm.js bottom-sheet, WS к ssh2
    └── composables/useAttachments.ts
```

Под `bun build --compile` фронт пакуется в exe через `import('./web/dist/...', { with: { type: 'file' } })` — отдельные ассеты не нужны. AppImage — это тонкий wrapper-script (AppRun) поверх того же бинарника + загрузочная HTML-страница пока сервер стартует.

## Аутентификация SSH

По умолчанию `root` / `wirenboard` (заводские креды Wirenboard). В «Настройках»:

1. **Приватный ключ** — путь к файлу. Используется первым.
2. **Пароль** — fallback (с keyboard-interactive).

## Custom AI Proxy

Для корпоративных прокси с TLS-MITM, которые проксируют OpenAI-совместимые endpoint (Copilot, корпоративный gateway и т.п.):

1. Провайдер: **Custom AI Proxy**
2. Base URL: реальный upstream API (например `https://api.githubcopilot.com`)
3. API-ключ: можно dummy, если прокси сам подставит реальный
4. Прокси для LLM: `https://USER:PASS@host:port` (auth прямо в URL — отдельные поля логин/пароль скрыты)
5. CA-сертификат прокси: загрузить `.pem` файл — его содержимое сохранится в `settings.json` и пойдёт в `tls.ca` Bun fetch

Кнопка «обновить список» работает даже если прокси не отдаёт `/v1/models`: дёргает `/v1/chat/completions` с фейковой моделью и парсит «Available models: …» из 400-го ответа. Whitelist режет до моделей, совместимых с `/chat/completions` (без reasoning-only — gpt-5.x main, o-серия и т.п.).

> **Только OpenAI Chat Completions API.** Anthropic Messages API не поддерживается, даже если прокси умеет в обе стороны.

## Переменные окружения

Применяются только при первом запуске и записываются в `settings.json`:

```
OPENAI_API_KEY              стартовый ключ LLM
OPENAI_BASE_URL             свой эндпоинт
OPENAI_MODEL                имя модели
WB_HELPER_PORT              порт UI (default 17321)
WB_HELPER_OPEN_BROWSER      0 чтобы не открывать окно
WB_HELPER_DISCOVERY_INTERVAL  интервал mDNS-скана, мс (default 15000)
WB_HELPER_MQTT_USER         MQTT-логин
WB_HELPER_MQTT_PASSWORD     MQTT-пароль
WB_HELPER_SSH_USER          SSH-логин (default root)
WB_HELPER_SSH_PASSWORD      SSH-пароль (default wirenboard)
WB_HELPER_SSH_KEY           путь к приватному ключу
```

