# Changelog

Все заметные изменения проекта документируются в этом файле.

Формат: [Keep a Changelog](https://keepachangelog.com/ru/1.1.0/),
версионирование: [Semantic Versioning](https://semver.org/lang/ru/).

## [Unreleased]

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

[Unreleased]: https://github.com/wirenboard/wb-ai-helper-desktop/compare/v0.13.1...HEAD
[0.13.1]: https://github.com/wirenboard/wb-ai-helper-desktop/compare/v0.13.0...v0.13.1
[0.13.0]: https://github.com/wirenboard/wb-ai-helper-desktop/compare/v0.12.1...v0.13.0
