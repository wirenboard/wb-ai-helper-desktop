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
   - **OpenAI** — [platform.openai.com/api-keys](https://platform.openai.com/api-keys); пополнить баланс через credit card. Рекомендуемая модель — `gpt-4.1` или `gpt-5.4-mini`
   - **AITunnel** — [aitunnel.ru](https://aitunnel.ru/) (RUB-биллинг, оплата с российской карты, 200+ моделей включая Claude/GPT/Gemini)
   - **Self-hosted** — Ollama / LiteLLM / vLLM на своём сервере, ключ необязателен
   - **Корпоративный/MITM-прокси** — см. раздел [Custom AI Proxy](#custom-ai-proxy) ниже
3. **Запустить и настроить:**
   - `chmod +x ./WB-AI-Helper-x86_64.AppImage && ./WB-AI-Helper-x86_64.AppImage`
   - В шапке открыть «Настройки» (⚙)
   - Выбрать провайдера → вставить ключ → нажать «обновить список» → выбрать модель → «Сохранить»
4. Контроллеры в правой колонке появятся сами через mDNS. Если в сети закрыт mDNS — добавь вручную по hostname/IP.
5. Чат активен. Например: «что подключено на шине RS-485?», «пришли график температуры процессора со вчерашнего дня».

### Что качать?

| Файл | ОС | Описание |
|------|----|----------|
| `WB-AI-Helper-x86_64.AppImage` | Linux | Всё-в-одном: сервер + автозапуск Chrome в app-режиме (без адресной строки). Если Chrome/Chromium не установлен — откроет UI в дефолтном браузере через `xdg-open` |
| `wb-ai-helper-linux-x64` | Linux | Standalone CLI/сервер. Поднимает HTTP на порту 17321, открывает браузер. Подходит для headless или когда AppImage не нужен |
| `wb-ai-helper-windows-x64.exe` | Windows | Standalone сервер. Поднимает HTTP на порту 17321 и открывает браузер |

## Что умеет

**Поиск и работа с контроллерами:**
- **mDNS-сканер сети** — автоматически находит контроллеры по паттерну `wirenboard-<SN>.local`. Список обновляется каждые ~15 секунд. Если в сети закрыт mDNS, контроллер можно добавить вручную по hostname или IP
- **Web UI контроллера** — клик по 🌐 в карточке открывает web-интерфейс контроллера в новой вкладке
- **Встроенный SSH-терминал** — клик по ▷_ открывает выезжающую снизу панель с xterm.js поверх ssh2-сессии. Горячие клавиши, цвета, ANSI escape — всё работает
- Несколько чатов параллельно, каждый со своим контекстом контроллеров (один / выбранная группа / все)

**LLM с tool-calling:**
- 4 профиля провайдеров: **OpenAI** (прямой доступ), **AITunnel** (RUB-биллинг, баланс/статистика прямо в настройках), **Custom** (Ollama, LiteLLM, vLLM…), **Custom AI Proxy** (MITM-прокси с CA-сертификатом). Каждый хранит свой ключ/baseURL/model/прокси/CA/temperature/contextWindow/auto-сжатие — переключаются мгновенно
- Per-provider контроль контекстного окна: автоопределение из `/v1/models` (для провайдеров типа OpenRouter), ручной override, опциональная отдельная (более дешёвая) модель для checkpoint, авто-сжатие при заполнении ≥ настраиваемого порога
- ~50 инструментов: `mqtt_*`, `ssh_*`, `wb_bus_scan`, `serial_debug_collect`, `audit_controller`, `get_history`/`get_history_chart` (графики через vega-lite — line/bar/area/point/histogram/heatmap/boxplot), `fetch_from_controller`/`upload_to_controller`, `save_rule`/`load_rule`/`delete_rule` (wb-rules через `wbrules/Editor`)
- 17 скиллов (`controller-backup`, `controller-update`, `wb-mqtt-serial`, `wb-rules`, `troubleshooting-*`, `diagrams`, `history` и др.) — подгружаются по запросу через `load_skill`
- Фоновые задачи (`ssh_exec_async`, `wb_bus_scan`, `serial_debug_collect`) — запуск через `systemd-run` на контроллере, инлайн-индикатор в чате с 5-сек undo отмены
- Аттачменты: пользовательские (через 📎) и созданные моделью (`fetch_from_controller`/`get_history_chart`) разделены по source — модель не получает свои файлы обратно
- Стоимость per-сообщение (USD/1M токенов для OpenAI, серверная стоимость в RUB для AITunnel/VseGPT через `usage.cost_rub`/`total_cost`)
- Понятные ошибки провайдера: 401 «недействительный ключ», 402 «недостаточно средств», 403 «модерация» (с причинами/фрагментом), 408/429/502 — без сырого stacktrace

**UI/UX:**
- Сворачиваемые боковые панели (чаты слева, контроллеры справа)
- Поиск по моделям (typeahead)
- Удаление чата + «удалить все» с 5-сек undo
- Экспорт/импорт настроек в JSON (включая ключи и CA)
- Тёмная/светлая/авто-тема, регулировка размера шрифта

## Где хранятся данные

| Режим | Путь |
|-------|------|
| AppImage / dev | `~/.config/wb-ai-helper/` (Linux/XDG) |
| Standalone-бинарник | рядом с бинарником |

Файлы: `settings.json`, `wb-ai-helper.db` (SQLite WAL — чаты, история), `attachments/<chatId>/` (вложения). Старые чаты автоматически чистятся через 24 ч.

## Аутентификация SSH

По умолчанию `root` / `wirenboard` (заводские креды Wiren Board). В «Настройках»:

1. **Приватный ключ** — путь к файлу. Используется первым.
2. **Пароль** — fallback (с keyboard-interactive).

## Custom AI Proxy

Для корпоративных прокси с TLS-MITM, которые проксируют OpenAI-совместимые endpoint (Copilot, корпоративный gateway и т.п.):

1. Провайдер: **Custom AI Proxy**
2. Base URL: реальный upstream API (например `https://api.githubcopilot.com`)
3. API-ключ: можно dummy, если прокси сам подставит реальный
4. Прокси для LLM: `https://USER:PASS@host:port` (auth прямо в URL)
5. CA-сертификат прокси: загрузить `.pem` файл — его содержимое сохранится в `settings.json` и пойдёт в `tls.ca` Bun fetch

Кнопка «обновить список» работает даже если прокси не отдаёт `/v1/models`: дёргает `/v1/chat/completions` с фейковой моделью и парсит «Available models: …» из 400-го ответа.

> **Только OpenAI Chat Completions API.** Anthropic Messages API не поддерживается.

## Сборка и разработка

Зависимости: [Bun](https://bun.sh) 1.3+ (Node.js не требуется).

```bash
bun install

# Сборка
bun scripts/build.ts                    # бинарник под текущую платформу
bun scripts/build.ts --all              # linux-x64 + windows-x64
bun scripts/build.ts --target=linux-x64 # явный таргет
bun scripts/build-appimage.ts           # AppImage (нужен appimagetool + собранный linux-x64)
bun scripts/smoke.ts                    # smoke-тест собранного бинаря

# Тесты
bun test                                # все тесты
bun test:unit                           # юнит + лёгкая интеграция (без бинаря)
bun test:api                            # API-интеграция (нужен собранный бинарник)

# Проверка типов
bun run typecheck                       # tsc + vue-tsc

# Разработка (два терминала)
bun run dev:server                      # бэкенд с hot-reload на :17321
bun run dev:web                         # vite-dev на :5173 с прокси /api → :17321
```

Бинарники появятся в `build/`. В dev-режиме открыть `http://127.0.0.1:5173/`.

## CI/CD

GitHub Actions автоматически собирает проект.

- **CI** (push в `main`, pull requests) — typecheck → build (linux-x64 + windows-x64) → upload artifacts (14 дней)
- **Release** (push тега `v*`) — typecheck → build → AppImage → GitHub Release с бинарниками

### Как сделать релиз

```bash
git tag v0.13.0
git push origin v0.13.0
```

Тег должен соответствовать `package.json:version`.

Через ~1 минуту бинарники появятся на странице [Releases](../../releases).

## Архитектура

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

Под `bun build --compile` фронт пакуется в бинарник через `import('./web/dist/...', { with: { type: 'file' } })` — отдельные ассеты не нужны. AppImage — wrapper-script (AppRun) поверх того же бинарника, который ищет Chrome/Chromium и запускает его в `--app` режиме.

## Переменные окружения

Применяются только при первом запуске и записываются в `settings.json`:

| Переменная | Описание | По умолчанию |
|------------|----------|-------------|
| `OPENAI_API_KEY` | стартовый ключ LLM | — |
| `OPENAI_BASE_URL` | свой эндпоинт | `https://api.openai.com/v1` |
| `OPENAI_MODEL` | имя модели | — |
| `WB_HELPER_PORT` | порт UI | `17321` |
| `WB_HELPER_OPEN_BROWSER` | `0` чтобы не открывать окно | `1` |
| `WB_HELPER_DISCOVERY_INTERVAL` | интервал mDNS-скана, мс | `15000` |
| `WB_HELPER_MQTT_USER` | MQTT-логин | — |
| `WB_HELPER_MQTT_PASSWORD` | MQTT-пароль | — |
| `WB_HELPER_SSH_USER` | SSH-логин | `root` |
| `WB_HELPER_SSH_PASSWORD` | SSH-пароль | `wirenboard` |
| `WB_HELPER_SSH_KEY` | путь к приватному ключу | — |
