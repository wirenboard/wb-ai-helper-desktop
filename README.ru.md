# WB AI Helper — десктопный AI-ассистент для Wiren Board

[English](README.md) · **Русский**

> **Прототип / экспериментальный проект.**
> Ранняя версия для внутреннего тестирования, не готова к использованию в критичных продакшен-средах.
> Инструмент имеет прямой доступ к контроллерам по MQTT и SSH — включая запись топиков, выполнение произвольных команд и фоновых задач через `systemd-run`. Используйте осознанно и на свой страх и риск.

![Главное окно](docs/screenshots/main.png)

Один бинарник для Linux / Windows + AppImage для Linux-десктопа. Скачал → запустил → открывается встроенное окно Chrome с чатом и списком контроллеров, найденных в локальной сети через mDNS (`wirenboard-<SN>.local`). Ключи LLM, учётные данные MQTT и SSH задаются в UI и хранятся в `~/.config/wb-ai-helper/` (или рядом с бинарником в standalone-режиме).

## Быстрый старт

1. **Скачайте сборку под свою ОС** со страницы [Releases](../../releases/latest):
   - Linux-десктоп: `WB-AI-Helper-x86_64.AppImage` (всё-в-одном с UI)
   - Linux CLI / сервер: `wb-ai-helper-linux-x64`
   - Windows: `wb-ai-helper-windows-x64.exe`
2. **Получите API-ключ** у любого OpenAI-совместимого провайдера:
   - **OpenAI** — [platform.openai.com/api-keys](https://platform.openai.com/api-keys); пополните баланс банковской картой. Рекомендуемая модель — `gpt-4.1` или `gpt-5.4-mini`
   - **AITunnel** — [aitunnel.ru](https://aitunnel.ru/) (доступен из России без VPN, биллинг в рублях, оплата российской картой, 200+ моделей, включая Claude/GPT/Gemini)
   - **OpenRouter** — [openrouter.ai](https://openrouter.ai/) (300+ моделей; оплата картой или через Alipay, который пополняется из Сбера или Т-Банка)
   - **Self-hosted** — Ollama / LiteLLM / vLLM на своём сервере, ключ опционален
   - **Корпоративный / MITM-прокси** — см. раздел [Custom AI Proxy](#custom-ai-proxy) ниже
3. **Запустите и настройте:**
   - `chmod +x ./WB-AI-Helper-x86_64.AppImage && ./WB-AI-Helper-x86_64.AppImage`
   - Откройте «Настройки» (⚙) в шапке
   - Выберите провайдера → вставьте ключ → нажмите «обновить список» → выберите модель → «Сохранить»
4. Контроллеры в правой колонке появляются автоматически через mDNS. Если mDNS заблокирован в вашей сети — добавьте контроллер вручную по hostname/IP.
5. Чат готов к работе. Например: «что подключено на шине RS-485?», «пришли график температуры CPU со вчерашнего дня».

### Что скачивать?

| Файл | ОС | Описание |
|------|----|----------|
| `WB-AI-Helper-x86_64.AppImage` | Linux | Всё-в-одном: сервер + автозапуск Chrome в app-режиме (без адресной строки). Если Chrome/Chromium не установлен — открывает UI в браузере по умолчанию через `xdg-open` |
| `wb-ai-helper-linux-x64` | Linux | Standalone CLI/сервер. Отдаёт HTTP на порту 17321, открывает браузер. Подходит для headless-использования или когда AppImage не нужен |
| `wb-ai-helper-windows-x64.exe` | Windows | Standalone-сервер. Отдаёт HTTP на порту 17321 и открывает браузер |

## Что умеет

**Обнаружение и работа с контроллерами:**
- **mDNS-сканер сети** — автоматически находит контроллеры по шаблону `wirenboard-<SN>.local`. Список обновляется примерно каждые 15 секунд. Если mDNS заблокирован в сети, контроллер можно добавить вручную по hostname или IP
- **Веб-интерфейс контроллера** — клик по 🌐 на карточке открывает веб-интерфейс контроллера в новой вкладке
- **Встроенный SSH-терминал** — клик по ▷_ открывает нижнюю панель с xterm.js поверх ssh2-сессии. Горячие клавиши, цвета, ANSI-escape — всё работает
- Несколько чатов параллельно, у каждого свой контекст контроллеров (один / выбранная группа / все)

**LLM с tool-calling:**
- 5 профилей провайдеров: **OpenAI** (прямой доступ), **AITunnel** (биллинг в рублях, баланс/статистика прямо в настройках), **OpenRouter** (USD, баланс/лимиты ключа в настройках, 300+ моделей, автоопределение контекста из `/v1/models`), **Custom** (Ollama, LiteLLM, vLLM…), **Custom AI Proxy** (MITM-прокси с CA-сертификатом). Каждый хранит свои ключ/baseURL/модель/прокси/CA/temperature/contextWindow/авто-компакцию — переключается мгновенно
- Управление окном контекста по каждому провайдеру: автоопределение из `/v1/models` (для провайдеров вроде OpenRouter), ручное переопределение, опциональная отдельная (более дешёвая) модель для чекпоинтов, авто-компакция при заполнении окна выше настраиваемого порога
- ~50 инструментов: `mqtt_*`, `ssh_*`, `wb_bus_scan`, `serial_debug_collect`, `audit_controller`, `get_history`/`get_history_chart` (графики через vega-lite — line/bar/area/point/histogram/heatmap/boxplot), `fetch_from_controller`/`upload_to_controller`, `save_rule`/`load_rule`/`delete_rule` (wb-rules через `wbrules/Editor`)
- 17 навыков (`controller-backup`, `controller-update`, `wb-mqtt-serial`, `wb-rules`, `troubleshooting-*`, `diagrams`, `history` и другие) — подгружаются по требованию через `load_skill`
- Фоновые задачи (`ssh_exec_async`, `wb_bus_scan`, `serial_debug_collect`) — запускаются через `systemd-run` на контроллере, с инлайн-индикатором в чате и 5-секундной отменой
- Вложения: пользовательские загрузки (через 📎) и файлы, созданные моделью (`fetch_from_controller`/`get_history_chart`), разделяются по источнику — модель не получает обратно свои же файлы
- Стоимость каждого сообщения (USD за 1M токенов для OpenAI, серверная стоимость в рублях для AITunnel/VseGPT через `usage.cost_rub`/`total_cost`)
- Читаемые ошибки провайдеров: 401 «неверный ключ», 402 «недостаточно средств», 403 «модерация» (с причинами/фрагментом), 408/429/502 — без сырого стек-трейса

**UI/UX:**
- Сворачиваемые боковые панели (чаты слева, контроллеры справа)
- Поиск модели (typeahead)
- Удаление чата + «удалить все» с 5-секундной отменой
- Экспорт/импорт настроек в JSON (включая ключи и CA)
- Тёмная/светлая/авто тема, настройка размера шрифта

## Где хранятся данные

| Режим | Путь |
|-------|------|
| AppImage / dev | `~/.config/wb-ai-helper/` (Linux/XDG) |
| Standalone-бинарник | рядом с бинарником |

Файлы: `settings.json`, `wb-ai-helper.db` (SQLite WAL — чаты, история), `attachments/<chatId>/` (вложения). Старые чаты очищаются автоматически через 24 ч.

## SSH-аутентификация

По умолчанию `root` / `wirenboard` (заводские учётные данные Wiren Board). В «Настройках»:

1. **Приватный ключ** — путь к файлу. Пробуется первым.
2. **Пароль** — запасной вариант (с keyboard-interactive).

## Custom AI Proxy

Для корпоративных прокси с TLS-MITM, которые проксируют OpenAI-совместимые эндпоинты (Copilot, корпоративный шлюз и т.п.):

1. Провайдер: **Custom AI Proxy**
2. Base URL: реальный upstream API (например, `https://api.githubcopilot.com`)
3. API-ключ: может быть фиктивным, если прокси подставляет настоящий
4. Прокси для LLM: `https://USER:PASS@host:port` (авторизация прямо в URL)
5. CA-сертификат прокси: загрузите `.pem`-файл — его содержимое сохраняется в `settings.json` и попадает в `tls.ca` fetch-а Bun

Кнопка «обновить список» работает, даже если прокси не отдаёт `/v1/models`: она обращается к `/v1/chat/completions` с фейковой моделью и парсит «Available models: …» из ответа 400.

> **Только OpenAI Chat Completions API.** Anthropic Messages API не поддерживается.

## Сборка и разработка

Зависимости: [Bun](https://bun.sh) 1.3+ (Node.js не требуется).

```bash
bun install

# Сборка
bun scripts/build.ts                    # бинарник под текущую платформу
bun scripts/build.ts --all              # linux-x64 + windows-x64
bun scripts/build.ts --target=linux-x64 # явная цель
bun scripts/build-appimage.ts           # AppImage (нужны appimagetool + собранный linux-x64)
bun scripts/smoke.ts                    # smoke-тест собранного бинарника

# Тесты
bun test                                # все тесты
bun test:unit                           # unit + лёгкая интеграция (без бинарника)
bun test:api                            # API-интеграция (нужен собранный бинарник)

# Проверка типов
bun run typecheck                       # tsc + vue-tsc

# Разработка (два терминала)
bun run dev:server                      # бэкенд с hot-reload на :17321
bun run dev:web                         # vite dev на :5173 с прокси /api → :17321
```

Бинарники складываются в `build/`. В dev-режиме открывайте `http://127.0.0.1:5173/`.

## CI/CD

GitHub Actions собирает проект автоматически.

- **CI** (push в `main`, pull request'ы) — typecheck → сборка (linux-x64 + windows-x64) → загрузка артефактов (14 дней)
- **Release** (push тега `v*`) — typecheck → сборка → AppImage → GitHub Release с бинарниками

### Как выпустить релиз

Перед тегированием:
1. Поднимите `version` в `package.json`.
2. Перенесите записи из `## [Unreleased]` в `CHANGELOG.md` в новый раздел `## [X.Y.Z] — YYYY-MM-DD` и добавьте ссылку для сравнения внизу.
3. Закоммитьте «chore: release X.Y.Z», смержите в `main`.

```bash
git tag v0.13.0
git push origin v0.13.0
```

Тег должен совпадать с `package.json:version`. Примерно через минуту release-workflow соберёт и опубликует сборку.

Примерно через минуту бинарники появятся на странице [Releases](../../releases).

## Архитектура

```
src/
├── server/                  Bun + Hono, всё в одном процессе
│   ├── index.ts             Bun.serve: HTTP + SSE + WebSocket (SSH-терминал)
│   ├── settings.ts          профили провайдеров, CA-сертификат инлайн (PEM в JSON)
│   ├── llm.ts               OpenAI streaming, agent loop (до 20 ходов)
│   ├── tools.ts             ~50 инструментов: mqtt/ssh/discovery/history/wb-rules
│   ├── history-chart.ts     рендеринг графиков через vega-lite SSR (line/bar/heatmap/...)
│   ├── jobs.ts              трекер фоновых SSH-задач (in-memory)
│   ├── attachments.ts       файлы с меткой source='user'|'assistant'
│   ├── chats.ts             SQLite-хранилище chats/turns + системный промпт (языковая директива RU/EN)
│   ├── skills.ts            каталог + загрузка навыков (английский, для модели) в контекст LLM
│   ├── ssh.ts               пул ssh2-клиентов, exec/jobStart/openShell, SFTP
│   ├── mqtt-pool.ts         пул mqtt.js-клиентов
│   ├── discovery.ts         mDNS/avahi-browse сканер
│   ├── db.ts                bun:sqlite WAL + миграции
│   └── fixtures/skills/     17 markdown-навыков
└── web/                     Vue 3, Vite, без UI-фреймворка
    ├── App.vue              корневой layout
    ├── api.ts               API-клиент + типы
    ├── i18n.ts              UI-словари RU/EN + t()/plural()/fmtSize(), реактивный lang
    ├── components/
    │   ├── ChatList.vue                Левый сайдбар (чаты + отмена delete-all)
    │   ├── ChatPane.vue                Чат + поле ввода
    │   ├── ChatMessageList.vue         Список сообщений + инлайн-задачи
    │   ├── ChatMessage.vue             Один пузырь (markdown + mermaid + hljs + файлы)
    │   ├── ChatInputArea.vue           Текст + вложения + drag-drop
    │   ├── ControllerList.vue          Правый сайдбар + иконки Web UI/Терминал
    │   ├── SettingsPanel.vue           Провайдеры, ключи, CA-сертификат, цены, экспорт/импорт
    │   ├── ComboboxSearch.vue          Typeahead-выбор модели
    │   └── SshTerminal.vue             xterm.js нижняя панель, WS к ssh2
    └── composables/useAttachments.ts
```

Под `bun build --compile` фронтенд упаковывается в бинарник через `import('./web/dist/...', { with: { type: 'file' } })` — отдельные ассеты не нужны. AppImage — это скрипт-обёртка (AppRun) над тем же бинарником, который находит Chrome/Chromium и запускает его в `--app`-режиме.

### Локализация (RU/EN)

Принцип: **текст для пользователя — двуязычный; текст для модели — одноязычный (английский), потому что модель сама переводит между языками**.

- **UI** — `src/web/i18n.ts`: лёгкий модуль без vue-i18n (`t()`/`plural()`/`fmtSize()`, реактивный `lang`, автоопределение из `localStorage('wb-lang')` + `navigator.language`). Компоненты импортируют `t`/`plural` напрямую. Чтобы добавить строку — положите ключ в оба блока `ru`/`en` и используйте `t('group.key')`.
- **`settings.uiLanguage`** (общее поле, env `WB_HELPER_LANGUAGE`) задаёт язык UI и те немногие серверные строки, которые видит пользователь: языковую директиву системного промпта (`LANG_DIRECTIVE` в `chats.ts` — блок высшего приоритета, добавляемый в начало системного промпта, который заставляет модель **отвечать строго на языке UI**, переопределяя русское тело персоны), welcome/fallback/checkpoint-сообщения и `getExtraSystemMsgs` (через хелпер `L()` в `index.ts`).
- **Навыки (`fixtures/skills/*.md`) и описания инструментов (`tools.ts`) — только на английском, единый набор.** Это инструкции для модели, никогда не показываемые пользователю дословно; модель читает английский и всё равно отвечает на языке UI. Никаких `.en.md`-вариантов, никакого `toolSchemas(lang)`. Блоки `{en, ru}` / `translations.ru` внутри `wb-rules.md` и `wb-serial-templates.md` оставлены намеренно — они документируют двуязычные API самих этих навыков.
- Префикс `[System]` — технический протокольный маркер, не переводится (фронтенд убирает его перед отображением).

## Переменные окружения

Применяются только при первом запуске и записываются в `settings.json`:

| Переменная | Описание | По умолчанию |
|------------|----------|--------------|
| `OPENAI_API_KEY` | начальный ключ LLM | — |
| `OPENAI_BASE_URL` | кастомный endpoint | `https://api.openai.com/v1` |
| `OPENAI_MODEL` | имя модели | — |
| `WB_HELPER_PORT` | порт UI | `17321` |
| `WB_HELPER_OPEN_BROWSER` | `0` — не открывать окно | `1` |
| `WB_HELPER_LANGUAGE` | язык UI/ассистента: `ru` или `en` | `ru` |
| `WB_HELPER_DISCOVERY_INTERVAL` | интервал mDNS-сканирования, мс | `15000` |
| `WB_HELPER_MQTT_USER` | логин MQTT | — |
| `WB_HELPER_MQTT_PASSWORD` | пароль MQTT | — |
| `WB_HELPER_SSH_USER` | логин SSH | `root` |
| `WB_HELPER_SSH_PASSWORD` | пароль SSH | `wirenboard` |
| `WB_HELPER_SSH_KEY` | путь к приватному ключу | — |
