# Changelog

Все заметные изменения проекта документируются в этом файле.

Формат: [Keep a Changelog](https://keepachangelog.com/ru/1.1.0/),
версионирование: [Semantic Versioning](https://semver.org/lang/ru/).

## [Unreleased]

## [0.13.2] — 2026-05-07

### Fixed
- Баннер фоновой задачи больше не мерцает / не пропадает во время длинных
  ответов модели и пока контроллер недоступен (например, при `apt upgrade`
  с обновлением ядра и reboot). Две причины:
  1. `GET /api/chats/:id/jobs` дёргал SSH `jobStatus` для каждой running-job
     синхронно. На недоступном контроллере запрос висел до handshake-таймаута
     (~20 с), параллельные UI-poll'ы накладывались, и иногда один из них
     возвращал устаревший / несогласованный state — баннер исчезал.
  2. `refreshJobs()` на стороне UI при любой ошибке сбрасывал
     `runningJobs = []`, и баннер пропадал на 1–2 секунды до следующего
     успешного polling.

### Changed
- Обновление состояния running-задач вынесено в фоновый tracker
  (`startJobTracker` в `jobs.ts`): каждые 5 секунд бэкенд опрашивает
  SSH `jobStatus`, не блокируя UI-endpoint. Транзиентная SSH-ошибка
  оставляет `state: running` до следующей попытки. UI получает текущий
  in-memory state мгновенно. Когда задача завершилась — frontend
  следующим тиком видит `state: exited` и автоматически уведомляет модель.

## [0.13.1] — 2026-05-07

### Fixed
- При создании нового чата (кнопка «+») контекст больше не наследуется
  от текущего активного чата. Раньше `newChat()` копировал `selectedSns`
  из открытого чата, и SN «прилипал» — после перезапуска казалось, что
  приложение само выбрало контроллер. Каждый новый чат теперь стартует
  с пустым контекстом.

## [0.13.0] — 2026-05-07

### Added
- **AITunnel** — новый провайдер (api.aitunnel.ru/v1, RUB-биллинг через
  `usage.cost_rub`). Баланс / 30-дневная статистика / email прямо в
  настройках через `GET /api/aitunnel/info`; прогноз «хватит на N дней»
  и подсветка красным когда дней <3.
- **Per-provider контекст**: `contextWindow`, `compactModel`, `autoCompact`,
  `autoCompactThreshold`, `temperature` теперь у каждого провайдера свои.
- **Авто-определение контекстного окна** из `/v1/models` (поля
  `context_length` / `context_window` / `top_provider.context_length` /
  `max_input_tokens` — покрывает OpenRouter, LiteLLM, Ollama-compat).
- **Авто-сжатие контекста**: клиентский watch на ratio заполнения с
  настраиваемым порогом; при превышении автоматически шлёт `checkpoint`,
  опционально через отдельную (более дешёвую) `compactModel`.
- **Понятные ошибки провайдера** — `formatLlmError()` парсит структуру
  AITunnel `{error: {code, message, metadata}}` и стандартный OpenAI shape:
  401 «недействительный ключ», 402 «недостаточно средств», 403 «модерация»
  (с reasons / flagged_input / provider_name), 408/429/502.
- **Auto-save API-ключа** на ввод (debounce 600 мс).
- **`temperature`** как опциональное per-provider поле (пусто = дефолт
  провайдера).

### Changed
- Чекпоинт-стрим теперь использует `compactModel` (если задан) только для
  одного вызова — основная модель не подменяется.
- Прогресс-бар контекста и кнопка «📦 сжать» в шапке чата скрыты, когда
  `autoCompact` отключён (для AITunnel — по умолчанию).
- `ssh_exec` фильтрует stderr-шум `WARNING: apt does not have a stable
  CLI interface...`; для `apt list --upgradable` без свежего `apt-get
  update` подсказывает обновить кэш и подгрузить скилл `controller-update`.

[Unreleased]: https://github.com/wirenboard/wb-ai-helper-desktop/compare/v0.13.2...HEAD
[0.13.2]: https://github.com/wirenboard/wb-ai-helper-desktop/compare/v0.13.1...v0.13.2
[0.13.1]: https://github.com/wirenboard/wb-ai-helper-desktop/compare/v0.13.0...v0.13.1
[0.13.0]: https://github.com/wirenboard/wb-ai-helper-desktop/compare/v0.12.1...v0.13.0
