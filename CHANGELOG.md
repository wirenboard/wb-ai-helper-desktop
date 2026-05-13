# Changelog

Все заметные изменения проекта документируются в этом файле.

Формат: [Keep a Changelog](https://keepachangelog.com/ru/1.1.0/),
версионирование: [Semantic Versioning](https://semver.org/lang/ru/).

## [Unreleased]

### Added
- **Подключение к контроллеру по IP/hostname и нестандартному SSH-порту.**
  Поле «добавить вручную» в правой панели теперь принимает синтаксис
  `host[:port]` — например `192.168.1.10`, `192.168.1.10:2222`,
  `wirenboard-abc.local:8022`. Порт сохраняется в `manual_controllers`
  (миграция `ALTER TABLE … ADD COLUMN port INTEGER`, идемпотентная) и
  используется `SshPool` вместо дефолтного 22. Если порт не указан —
  поведение прежнее (порт 22). В карточке контроллера рядом с хостом
  показывается `:<port>`, когда он отличается от 22.
- **Ad-hoc контроллер по IP[:port] из tool-вызова.** Если LLM передаёт в
  `sn` IP или hostname (опционально с `:port`), которого нет в реестре —
  `adHocController` собирает временный `Controller` с этим хостом и
  портом, и SSH-вызов проходит без предварительного «добавь в список».
  Раньше порт молча игнорировался → попытка подключиться на 22 висла.

## [0.13.20] — 2026-05-09

### Fixed
- **SSH-сессии: лимит на параллельные channels.** Симптом: запрос истории
  на 6+ каналов (внутри `get_history`/`get_history_chart`/`get_history_table`)
  упирался в `MaxSessions` контроллера — `mqttRpc` под капотом делает
  `mosquitto_sub`/`_pub` через ssh exec, и `Promise.all` по каналам открывал
  по одному channel на каждый. Аналогично — pre-flight через
  `mqtt_list_topics` (по уникальным device) и фоновый job-tracker с 5+
  running-задачами на одном контроллере.
- В `SshPool` добавлен per-controller семафор `MAX_PARALLEL_CHANNELS = 7`
  (sshd на WB настроен `MaxSessions=10`; ~3 слота оставлены пользователю
  на ручные ssh-подключения). Семафор оборачивает `exec`, `writeFile`,
  `writeFileBuffer`, `downloadFile`, `openShell`. `connect()` вне
  семафора — handshake не ест слот. Очередь FIFO, новые вызовы не
  обходят ожидающих. Интерактивный shell держит слот всё время сессии.

### Changed
- **`controller-update.md`: зонтичное согласие.** Раньше скилл требовал
  HITL перед каждым шагом сценария A (apt upgrade → kept back? →
  dist-upgrade → ядро обновилось? → reboot), даже если пользователь уже
  сказал «обнови всё, не спрашивай». Добавлен раздел «Зонтичное согласие»:
  фразы «обнови всё», «сделай это и всё остальное», «делай», «доведи до
  конца», «не спрашивай каждый раз», «мне нужна самая свежая» —
  разрешение на ВСЕ шаги сценария A. Не покрывает смену релиза
  (`wb-release -t`), `wb-release -p/-r` и destructive-команды вне
  сценария A — там HITL остаётся.

## [0.13.19] — 2026-05-08

### Fixed
- **Pre-flight валидация в history-тулзах.** Симптом: модель звала
  `get_history_chart` с выдуманным `device_id` (`wb-system`), тулза
  успешно сохраняла пустой SVG (db_logger возвращал 0 точек, ошибки нет).
  Корневая причина — два слоя:
  1. Скилл `history.md` сам подсказывал ложный пример с `wb-system`
     в Шаге 3, хотя в Шаге 1 был корректный `hwmon`. Модель копировала
     пример Шага 3 буквально.
  2. Тулзы не валидировали существование каналов перед запросом в БД.
- **`get_history`, `get_history_chart`, `get_history_table`** теперь
  делают pre-flight через MQTT (`mqtt_list_topics(prefix="/devices/<dev>/controls/+")`,
  параллельно по уникальным `device_id`). На несуществующий `device_id` —
  короткая ошибка без перечисления устройств. На несуществующий
  `control_name` — список только этого одного устройства (5-30 контролов,
  не сотни). Чистый хелпер `diagnoseHistoryChannels` экспортирован для тестов.
- В `history.md` все примеры с `wb-system` заменены на правильный `hwmon`
  (device_id для CPU/Board/GPU Temperature на WB), Шаг 1 усилен явной
  инструкцией о двух обязательных вызовах `mqtt_list_topics`.

### Tests
- Новый файл `tests/diagnose-history-channels.test.ts` — 8 юнит-тестов
  на чистый хелпер. Итого 387 pass.

## [0.13.18] — 2026-05-08

### Changed
- **Доработки существующих скиллов** (последний батч из бэклога):
  - `controller-update.md` — добавлен **Сценарий D: factory reset / откат
    пакетов** через `wb-release -p` (`--reset-packages`) и `-r`
    (`--regenerate`). Описана разница: `-p` приводит wb-\* пакеты к версиям
    текущего релиза (downgrade при необходимости, конфиги не трогает),
    `-r` перегенерирует системные конфиги из шаблонов wb-configs (риск
    перезаписать кастом → обязательный `controller-backup`). Явное
    разграничение с аппаратным factory reset (FIT-прошивкой), который мы
    не запускаем.
  - `zigbee.md` — расширена секция про **Z2M в Docker**: типичный
    `docker-compose.yml` с `network_mode: host`, проброс `/dev/ttyMODx`
    в `devices:`, маунт `./data` для конфига. Адаптеры (`ezsp` для
    WBE2R-R-ZIGBEE v.2). Грабли: без host network mosquitto не виден,
    конфиг WB-конвертера ставится на хост (не в контейнер), `docker compose`
    без дефиса.
  - `wb-mqtt-serial.md` — добавлен блок про **error-флаги канала
    (WB MQTT Conventions)**: `r` (read error), `w` (write error),
    `p` (period miss). Ключевое: при `r` значение контрола — last-known-good,
    не свежее → нельзя читать контрол без проверки `meta/error`. Сценарий
    «проверь живой ли канал» через `mqtt_read` на `meta/error`. Связь
    с `troubleshooting-serial` для диагностики физики шины при `r`/`rp`.

  Бэкенд-изменений нет — только обновлённые fixtures, которые сидятся
  в БД при старте через `embed-skills-manifest`.

### Backlog status
- ✅ Все 7 system-стек скиллов опубликованы (v0.13.15–v0.13.17).
- ✅ Доработки существующих скиллов из бэклога (этот релиз).
- `mqtt_list_topics` пагинация уже есть с предыдущих релизов.
- `mqtt_write` обрабатывает ошибки через try/catch на mqtt-клиенте.

Бэклог из `wb-ai-skills/wb-ai-helper-analysis.md` закрыт.

## [0.13.17] — 2026-05-08

### Added
- **`wb-serial-templates`** — последний из 7 system-стек скиллов из бэклога
  `wb-ai-skills/wb-ai-helper-analysis.md`. Создание собственных Modbus-
  шаблонов для `wb-mqtt-serial`: где живут шаблоны (`/usr/share/...` пакетные
  vs `/etc/wb-mqtt-serial.conf.d/templates/` пользовательские, переживают
  апгрейд), полный набор полей канала (`reg_type`, `format`, `scale`,
  `word_order`, `condition`, `error_value`, `unsupported_value` и т.п.),
  `parameters` для firmware-настроек, `groups` для UI-иерархии, `translations`
  для i18n. Workflow от чтения мануала до бэкапа в `/wb-controller-backup`.
  Готовый пример 1-фазного счётчика электроэнергии. Грабли:
  endianness (множитель 65535 при ошибке `word_order`), 0-based vs 1-based
  адреса, кириллица в `device.id`, дублирующий `device_type`.

  Итого 24 системных скилла (было 23 в v0.13.16). Все 7 скиллов из
  бэклога опубликованы.

## [0.13.16] — 2026-05-08

### Added
- **3 новых скилла** в `src/server/fixtures/skills/` (продолжение разбора
  бэклога из `wb-ai-skills/wb-ai-helper-analysis.md`, на русском):
  - **`wb-notifications`** — Telegram/email/SMS из wb-rules через `Notify.*`
    и централизованные тревоги через `alarms.conf`. Создание Telegram-бота
    через `@BotFather`, получение `chat_id` (личный/группа/канал).
    Локальный MTA через `msmtp-mta` для email (Gmail App Password). SMS
    через ModemManager (`mmcli`). Декларативные тревоги с `interval`
    для повторных уведомлений и `expectedValueParameter`/min/max для
    порогов. Грабли: захардкоденный токен, кириллица в SMS (70 символов
    на одно), Gmail без App Password.
  - **`wb-scenarios`** — декларативный no-code движок поверх `wb-rules`:
    4 типа сценариев (`devicesControl`, `lightControl`, `thermostat`,
    `schedule`) описываются JSON в `/etc/wb-scenarios.conf`, под капотом
    генерируются `.js` правила. Граница "сценарий vs wb-rules": сложные
    условия / вычисления / счётчики → wb-rules. Сервис называется
    `wb-scenarios-reloader` (НЕ `wb-scenarios.service`).
  - **`wb-mqtt-broker`** — администрирование `mosquitto` на контроллере:
    структура `/etc/mosquitto/conf.d/` (НЕ редактировать `mosquitto.conf`
    напрямую), пароли (`mosquitto_passwd -c` грабли), ACL per-user, TLS
    на 8883 (self-signed CA для дома, Let's Encrypt для прода), мосты
    к чужим брокерам (HA, облако) с `cleansession false`. Принцип:
    WB-сервисы через Unix-сокет (анонимно), внешние клиенты — 1883/8883
    с аутентификацией. `per_listener_settings true` ключевой.

  Все 3 скилла загружаются автоматически при сборке через
  `embed-skills-manifest` и сидятся в БД на старте. Итого 23 системных
  скилла (было 20 в v0.13.15).

## [0.13.15] — 2026-05-08

### Added
- **3 новых system-стек скилла** в `src/server/fixtures/skills/` — компактные
  (по ~100 строк) версии под стиль существующих fixtures, на русском:
  - **`wb-services`** — управление systemd-юнитами, override-конфиги
    (drop-in для пакетных), создание своих сервисов и таймеров. Шпаргалка
    по `systemd_unit` tool'у + правильный паттерн override (с `ExecStart=`
    сбросом перед перепереопределением). Пример fix `fstrim.service`
    с `--quiet-unsupported`. Сравнение wb-rules cron vs systemd timer.
  - **`wb-network`** — NetworkManager + wb-connection-manager: подключение
    к WiFi, точка доступа, статический IP, 4G/sim1/sim2, OpenVPN-клиент,
    DNS, диагностика «нет интернета». Указывает использовать `network_status`
    как first-call. Описание архитектуры (NM делает соединения, WCM
    приоретизирует/failover'ит).
  - **`wb-cloud`** — wb-cloud-agent: активация (привязка к аккаунту),
    отвязка/сброс, свой бэкенд через `CLOUD_BASE_URL`, диагностика
    «не подключается к облаку». Указывает использовать `cloud_status`
    tool. Архитектурный блок про ATECCx08 и MQTT-публикацию состояния.

  Скиллы загружаются автоматически при сборке (через `scripts/build.ts`
  embed-skills-manifest, см. v0.13.6) и сидятся в БД на старте приложения.
  Параметрический тест `tests/skills-parse.test.ts` валидирует каждый
  shipping-`.md` через `extractDescription` — все 3 проходят.

## [0.13.14] — 2026-05-08

### Added
- **`modbus_device_info`** — прошивочные параметры конкретного Modbus-устройства:
  fw, model, текущие значения parameters (debounce, modes, mappings и т.п.).
  RPC `wb-mqtt-serial/device/LoadConfig`. Это **не** список каналов — для
  него `modbus_template`. Два режима: (1) по `device_id` (имя в MQTT
  типа `wb-mr6c_138`) — wb-mqtt-serial сам резолвит остальное; (2) по
  явным `path + slave_id` (+ опционально device_type/baud_rate/parity/
  data_bits/stop_bits) — для устройств не в конфиге.
- **`modbus_probe`** — точечный ping одного Modbus slave-id на указанном
  порту через `wb-mqtt-serial/device/Probe`. Не меняет конфиг, не
  перезапускает драйвер. Полезно когда `wb_bus_scan` пропустил
  устройство (известный кейс с WB-MAP6S — сканер не всегда видит,
  Probe видит).
- **`modbus_ports`** — параметры всех настроенных RS-485 портов
  (path, baud_rate, parity, data_bits, stop_bits, timeouts, enabled).
  RPC `wb-mqtt-serial/ports/Load`. Возвращает только активные порты
  из конфига, не все физически существующие `/dev/ttyRS485-*`.

### Diagnostics
- При таймауте `wb-mqtt-serial/device/LoadConfig` или `device/Probe`
  ошибка теперь обогащается hint'ом: «возможно версия драйвера < 2.180,
  проверь `dpkg -l wb-mqtt-serial`, обнови через `apt install`». Это не
  костыль — реальный кейс обнаружен на A25NDEMJ (wb7) с устаревшим
  `wb-mqtt-serial 2.146.0`: эти RPC endpoint'ы не отвечают, в репе stable
  лежит 2.224.0+ но pending update не применён. На свежей версии (2.180+
  на wb8) работает out of the box. Hint выдаётся только при таймауте,
  обычные RPC-ошибки (Port is not defined / bad params) проходят как есть.

### Fixed
- **`ssh_exec_async` теперь добавляет `-y` к apt-командам install/upgrade/
  dist-upgrade/remove/purge** (если не задан `-y`/`--yes`/`--assume-yes`).
  Раньше сервер добавлял только `DEBIAN_FRONTEND=noninteractive`, и
  модель забыв `-y` запускала, например, `apt-get install pkg` —
  dpkg ждал Y/N, default был N, пакет не ставился. Реально воспроизведено
  при попытке обновить wb-mqtt-serial на A25NDEMJ — пакет завис на
  2.146.0 и `device/LoadConfig` продолжал не отвечать. Логика
  нормализации вынесена в `src/server/apt-defaults.ts` (с +19 unit-тестов
  на edge cases: `-y` уже есть в коротком/длинном виде, имена пакетов
  с `-y` в названии типа `python3-yaml`, chained команды и т.п.).
  Скилл `controller-update.md` обновлён с новым правилом.

### Tests
- +7 unit-тестов на `buildLoadConfigParams` (`device_id` приоритет,
  fallback на `path+slave_id`, валидация null, прокидывание опциональных
  полей, корректная обработка `slave_id=0`).
- +4 unit-теста на `enrichSerialRpcError` (таймаут на ru/en распознаётся,
  hint про 2.180 добавлен; не-таймаут проходит без изменений; обработка
  не-Error значений).

## [0.13.13] — 2026-05-08

### Added
- **`modbus_templates_list`** — список Modbus-шаблонов через RPC
  `wb-mqtt-serial/config/Load.types`. Без `filter` возвращает сводку по
  группам (на типичной прошивке 250+ шаблонов, плоский список переполнил
  бы контекст). С `filter` (case-insensitive подстрока по type/mqtt-id/name)
  — flat list matched. Шаблоны с `deprecated: true` помечаются и считаются
  отдельно.
- **`modbus_template`** — содержимое одного шаблона по `device_type`
  (резолв через Load.types → mqtt-id) или прямо по `mqtt_id`. Читает
  `/usr/share/wb-mqtt-serial/templates/config-<mqtt-id>.json`. Views:
  `summary` (default — компактный список каналов с reg_type/address/format/
  type/units), `full` (весь шаблон), `channels-only`, `meta-only`.
  Опционально фильтрует каналы (`enabledOnly`, `channelFilter`).

### Fixed
- **MQTT `connack timeout` на холодном коннекте**: лимит `CONNECT_TIMEOUT`
  в `MqttPool` поднят с 4 сек до 8 сек. На медленных сетях / с mDNS-резолвом
  4 сек не хватало для TCP+MQTT handshake'а до контроллера на первом вызове
  `mqtt_inventory`/`list_devices`/etc.; со второго раза работало (соединение
  в кэше). 8 сек даёт запас, существующее кэширование сохраняет следующие
  вызовы быстрыми.

### Tests
- +25 unit-тестов в `tests/modbus-templates.test.ts` на парсеры/форматтеры:
  `parseTemplatesList` (flatten групп, deprecated, mqtt-id fallback,
  пустые), `filterTemplates` (substring case-insensitive по
  type/mqttId/name), `summarizeByGroup` (count/deprecated counts),
  `filterChannels` (enabledOnly + channelFilter), `renderTemplate`
  (4 views с фильтрами, не мутирует исходник, gracefully handles
  missing device).

## [0.13.12] — 2026-05-08

### Fixed
- **Автосжатие копилось и не срабатывало**: `compactContext()` отправлял
  модели мягкую просьбу «вызови checkpoint», и если модель её игнорировала
  (отвечала текстом без tool-call'а), gate `autoCompactTriggeredForRatio`
  залипал, ratio рос пока не вылетал за окно контекста — авто-сжатие
  больше не пыталось. Теперь два уровня:
  1. **SOFT (≥ autoCompactThreshold, default 0.85)** — модель просится
     вызвать `checkpoint(summary=...)`. Промт переписан жёстче: явно
     предупреждаем, что иначе при 90% мы обрежем историю принудительно
     и tool-results могут потеряться — её summary безопаснее.
  2. **HARD (≥ 0.9)** — backend сам обрезает историю в БД через новый
     endpoint `POST /api/chats/:id/force-compact`: оставляет system-турн
     и последний user-msg + всё после него; промежуточные turns
     заменяются одним synthetic `[Система] 🗜 Принудительное сжатие…`
     уведомлением со счётчиком выкинутого. Деструктивно для tool-results
     — но без него ratio растёт без ограничений.
  Gate сбрасывается на каждом юзерском `sendMessage` — каждый новый
  запрос даёт автосжатию свежий шанс.
- **Дефолт `autoCompactThreshold` снижен с 0.85 до 0.70** — 0.85 оставляло
  только 5pp запаса до HARD-сжатия (0.9), модель часто не успевала вызвать
  checkpoint между soft-просьбой и принудительной обрезкой. 0.70 даёт 20pp
  для нескольких итераций «попроси → подожди → попроси ещё раз». Существующие
  юзеры с сохранённым `0.85` (или другим значением) **остаются с прежним**
  — поменять можно через ⚙ Настройки или вручную в `settings.json`.

### Added
- **UI-индикатор `🗜 ждём checkpoint…`** в шапке чата рядом с context-meter,
  когда автосжатие отправило просьбу модели, но та ещё не вызвала checkpoint.
  С анимацией pulse, чтобы было заметно. Tooltip объясняет, что при 90%
  будет принудительное сжатие.
- **Счётчик фоновых задач `⏳ N`** в строке `ChatInputArea` рядом с «Ctrl+J
  — скачанные файлы». Показывается когда модель закончила, но ещё работают
  `ssh_exec_async`/`wb_bus_scan`/`serial_debug_collect` на контроллере.
  Tooltip предлагает узнать статус через `job_status`. 0 — индикатор скрыт.

### Tests
- +3 теста в `tests/db-chats.test.ts` на `ChatStore.forceCompact()`:
  обрезка middle turns с synthetic notice; noop при отсутствии истории
  для сжатия; сохранение последнего user-assistant pair при multi-iteration
  стриме.

## [0.13.11] — 2026-05-08

### Added
- **`mqtt_inventory`** — объединённый снимок MQTT-устройств одним вызовом:
  для каждого `/devices/<id>/`: id, name, driver, error + список контролов
  с распакованным `meta` (value, type, units, readonly, order, min/max,
  precision, error). Заменяет связку `list_devices` + N×`list_controls`.
  Поле `error` парсится по [WB MQTT Conventions](https://github.com/wirenboard/conventions):
  флаги `r` (read), `w` (write), `p` (period miss) и комбинации. **При
  `error.read=true` значение в value-топике — это last-known-good (последний
  успешно прочитанный), а не текущий live-readout** — без этого знания
  модель часто делает неверный диагноз. Опции: `device` (фильтр по подстроке),
  `timeout` (1-15 с), `includeEmpty`, `includeMeta` (raw meta-объект).
- **`disable_rule`** — отключить правило wb-rules через RPC
  `wbrules/Editor/ChangeState` (под капотом — переименование
  `<name>.js` → `<name>.js.disabled`). В отличие от `delete_rule` обратимо.
  На стабильных прошивках обратный `enabled:true` через тот же RPC возвращает
  `result:false` (ограничение wb-rules engine) — для включения обратно
  нужно вручную убрать суффикс `.disabled` и сделать reload.

### Tests
- +19 unit-тестов в `tests/mqtt-inventory.test.ts` на чистые `parseErrorFlags`
  и `buildInventory` — error-flags комбинации (r/w/p/rwp + unknown), сортировка
  контролов по `order`, фильтр по device-подстроке, `includeMeta`/`includeEmpty`,
  имена с пробелами (типа `Input 0 counter`), error → last-known-good в
  errors-сводке, malformed topics не ломают парсер.
- Парсер inventory вынесен в отдельный модуль `src/server/mqtt-inventory.ts` —
  чтобы тестировать без mock-MQTT. Сам tool-handler дёргает
  `MqttPool.listTopics`.

## [0.13.10] — 2026-05-08

### Added
- **`network_status`** — сетевая сводка контроллера в одном вызове:
  интерфейсы (`ip -j addr`) с IPv4-адресами и состоянием, default-маршрут
  (`ip -j route`), активные NetworkManager-соединения и устройства
  (`nmcli -t -f …`), опционально ping до целевого хоста. Типичный first-call
  для диагностики «нет интернета» / «отвалился uplink» / «не виден через
  VPN». Закрывает 3-4 ssh_exec-вызова, которые модель раньше делала вручную.
- **`cloud_status`** — состояние Wiren Board Cloud agent одним вызовом:
  активность сервиса `wb-cloud-agent`, наличие device-сертификата, список
  привязанных провайдеров, retained MQTT-контролы (status / activation_link
  / cloud_base_url) для каждого. По одному вызову видно, привязан ли
  контроллер к облаку и в каком статусе.

### Tests
- +23 unit-теста на чистые парсеры в `tests/diagnostics-parsers.test.ts`:
  `readMarkedSection`, `parsePingLossPct`, `normalizeInterface`,
  `pickDefaultRoute`, `parseNmcliColons`, `parseCloudMqttControls`. Сами
  tool-handler'ы (которые дёргают ssh.exec) тестируются на живом контроллере;
  парсеры покрывают всю интересную логику.

## [0.13.9] — 2026-05-08

### Changed
- Tooltip у счётчика 🔧 в подвале ассистент-сообщения переформулирован: было
  «В стоимость рядом входит N LLM-вызовов с инструментами в этом ответе —
  каждый итерационный вызов биллится отдельно», стало «Перед этим ответом
  было N LLM-вызовов с инструментами — стоимость рядом включает их.»
  Чище читается, ту же мысль доносит короче.

## [0.13.8] — 2026-05-08

### Fixed
- **Footer ассистент-сообщений показывал не того провайдера/модель/валюту**:
  поля `provider` / `model` тянулись из текущих глобальных settings, поэтому
  после переключения провайдера (например AITunnel ₽ → OpenAI $) прошлые
  сообщения «переезжали» — RUB-сумма становилась USD, имя бренда менялось.
  Теперь у таблицы `turns` две новые колонки `provider`/`model`, которые
  пишутся вместе с usage'ом на самом ассистент-турне; `ChatMessage.vue` берёт
  их оттуда, на легаси-записи без атрибуции остаётся fallback на текущие
  settings (как было).
- **`audit.ts`** — section-маркеры через `printf "\n…\n"` вместо `echo`. Файлы,
  cat'нутые без trailing `\n` (`/usr/lib/wb-release` оканчивается на
  `REPO_PREFIX=…`), склеивали следующий маркер с последней строкой и
  `splitSections` молча терял секцию (`manualPackages` в audit'е приходил
  пустым). Теперь маркер всегда на своей строке.
- **`serial_debug_collect`** — переписан по trap-protected паттерну:
  `python3` вместо хрупкого sed (идемпотентен после краша),
  `trap restore_off EXIT INT TERM` (debug:true не остаётся жить вечно при
  падении journalctl/systemctl), `START_TS=$(date -u)` до `sleep` (окно
  больше не сдвигается ретроактивно), без `-n 500` (раньше молча обрезало
  длинные капчи на нагруженной шине).
- **`mqtt_write`** — у `writeTopic()` и tool-схемы появились опциональные
  параметры `qos` (0/1/2) и `retain`. Раньше зашитые `{qos: 1, retain: false}`
  не давали публиковать retained-конфиги. Дефолты не изменились.
- **Раздутая live-сумма токенов в шапке чата** — `currentChatTokens` суммирует
  `tokensPrompt` по всем assistant-турнам в `liveTurns`, а каждый `tool-call`
  во время agent-loop'а пушит в `liveTurns` новый empty-assistant. На каждый
  такой пустой ассистент потом писался cumulative-снимок `usage` события, и
  на промежуточных оставались стейл cumulative-значения от прошлых итераций
  (одни и те же токены засчитывались по нескольку раз). В итоге шапка чата
  показывала, например, `$0.29` против `$0.08` в sidebar и per-message подвалах
  — реальный billing $0.08, а шапка обманывала. Теперь `usage`-handler знает
  границу текущего стрима (`streamStartIdx`) и обнуляет токены на промежуточных
  ассистентах стрима, оставляя cumulative только на самом последнем — сумма
  совпадает с DB.

### Added
- **В подвале каждого ассистент-сообщения — счётчик 🔧 N**, сколько LLM-вызовов
  с tool-call'ами было между предыдущим ответом/пользовательским сообщением и
  этим ответом. По tooltip'у объяснение: «в стоимость рядом входит N
  LLM-вызовов с инструментами в этом ответе — каждый итерационный вызов
  биллится отдельно». Юзер видит, что $0.05 на финальном тексте включает не
  только генерацию текста, но и весь chain tool-iterations стрима, и не задаёт
  вопросов «а где стоимость инструментов».
- **Два новых tool'а в категории «Системная диагностика»**:
  - `failed_units` — `systemctl --failed --no-pager`. Первый шаг диагностики
    «что-то сломалось» — заменяет 2-3 ssh_exec'а, которые модель делала
    раньше, чтобы понять *что* упало.
  - `systemd_unit { unit, action }` — один tool вместо ститчинга `is-active`
    / `show` / `status` / `cat` / `list-dependencies`. `action="status"`
    (default) отдаёт структурированный объект `{active, sub, load,
    unitFileState, exitCode, mainPid, since, statusTail}`. `cat` /
    `list-deps` read-only. `start`/`stop`/`restart`/`reload`/`enable`/
    `disable`/`mask`/`unmask` — state-changing с тем же HITL-предупреждением,
    что у `mqtt_write`/`write_file`. Имя юнита через whitelist-regex до
    шелла; covers сервисы, templated units (`getty@tty1.service`), таймеры,
    слайсы и пути.

## [0.13.7] — 2026-05-08

### Fixed
- Регрессия v0.13.6: welcome system_event при создании чата ломал две вещи.
  (1) Заголовок чата автогенерировался из первого user-турна, и им оказывался
  `[Система] OpenAI · gpt-5.4-mini · …` — в сайдбаре чатов и в шапке. Теперь
  `maybeAutoTitle` пропускает турны с префиксом `[Система]`: счётчик и сам
  title считаются по «настоящим» пользовательским сообщениям. (2) В пустом
  чате пропадали suggestion-кнопки (Обзор / Диагностика / Данные), потому
  что welcome-турн делал `items.length` ненулевым; ChatMessageList теперь
  считает чат пустым, если нет ни одного **не-`system_event`** items.

### Note
- v0.13.6 был снят с публикации из-за этих регрессий — пользуйтесь v0.13.7.

## [0.13.6] — 2026-05-08

### Fixed
- В скомпилированном бинаре (linux-x64, windows-x64, AppImage) фикстуры
  системных скиллов не попадали внутрь и `seedSystemSkills` молча выходил
  по ENOENT — таблица `skills` оставалась пустой, ни один системный скилл
  нельзя было загрузить через `load_skill`. Теперь `scripts/build.ts`
  отдельным шагом генерирует `embed-skills-manifest.ts` со статическими
  `import s0 from './fixtures/skills/X.md' with { type: 'text' }`, и Bun
  встраивает содержимое в бинарь как строки. В dev-режиме `seedSystemSkills`
  по-прежнему читает с диска. Молчаливый ENOENT-return заменён на
  `console.error` — такая регрессия больше не уйдёт незаметно. Параметрический
  тест `tests/skills-parse.test.ts` теперь прогоняет `extractDescription` на
  каждом шиппинговом `.md` и ловит скилл с невалидным первым абзацем до
  коммита.

### Added
- При создании нового чата сразу пишется ⚙ system_event со сводкой:
  `Модель: <name> · инструменты: <N> · скиллы: <M>`. Если скиллов 0 — в
  той же строке ⚠ предупреждение о баге сборки. Юзер видит, что заряжено,
  до первого сообщения; если бинарь без встроенных fixtures — проблема
  очевидна, а не закопана в server-stderr.

## [0.13.5] — 2026-05-08

### Fixed
- `job_tail` теперь возвращает поле `state` (`running` / `exited` /
  `unknown`) и при `running` — ещё и `_hint`, явно говорящий модели, что
  лог неполный и финальный ответ давать рано. Раньше `job_tail`
  бесшумно отдавал пустой/частичный хвост незавершённой задачи, и
  модель, увидев «logs пустые», делала ложный вывод (например,
  «обновлений нет», когда `apt update` ещё не дописал лог). Защита на
  уровне инструмента, а не системного промпта — state теперь часть
  данных, которую нельзя «забыть».

## [0.13.4] — 2026-05-08

### Added
- **OpenRouter** — пятый провайдер (`openrouter.ai/api/v1`, USD-биллинг
  через `usage.cost`). 300+ моделей включая Claude, GPT, Gemini, Llama;
  оплата картой или Alipay (можно пополнить из Сбербанка/ТБанка).
  В настройках: остаток / куплено / потрачено через `GET /api/openrouter/info`,
  лимиты ключа, rate-limit, free-tier флаг.
- **Vision (multi-modal images)** — при отправке user-сообщения с
  прикреплёнными `.png/.jpg/.gif/.webp` backend конвертирует токены
  `[file:id:name]` в `image_url` (data URL + base64). Vision-модели
  (gpt-4o, gpt-5.4-mini, claude-*) видят картинку нативно. У не-vision
  моделей провайдер вернёт ошибку, которую `formatLlmError` распарсит.
- **Архивы** (`zip` / `tar` / `tar.gz` / `tgz`) — три новых инструмента
  с авто-детектом формата по magic-bytes:
  - `list_archive_contents(fileId)` — листинг файлов внутри.
  - `read_from_archive(fileId, path, encoding)` — чтение одного файла
    напрямую (до 200KB).
  - `extract_archive(fileId, paths?)` — извлечь всё или подмножество в
    отдельные attachments чата. Работает и с архивами которые сама
    модель собрала через `fetch_from_controller`.
- **Per-provider rate-limit и retry** — поле «Минимальный интервал между
  запросами, мс» в настройках. На 429 backend делает до 3 попыток с
  backoff 3/8/20с, каждая попытка пишется в чат как system-event
  «⏳ Провайдер вернул 429 (rate limit). Попытка N/3, жду Xс…».
- **Кнопка «Повторить»** в баннере ошибки — повторяет запрос без
  дублирования user-сообщения в DB (флаг `retryLast: true`).
- **Per-provider `temperature`** — поле в настройках, null = дефолт
  провайдера.
- **Превью прикреплённых файлов** в чате: thumbnail для картинок (открывается
  по клику в новой вкладке), chip с именем + коротким fileId для
  остальных, кнопка × на hover чтобы удалить из чата. fileId виден в
  чате — наглядно сопоставить с тем что модель читает.
- **Real-time tokens / cost** в шапке чата: `usage` event эмитится после
  каждой итерации agent-loop'а, не только в финале — счётчики
  обновляются по ходу стрима.
- **Подсказки про доступность из России** — tooltip и плашка под радио-
  кнопкой провайдера: AITunnel (без VPN, оплата ₽), OpenRouter (Alipay,
  пополнение из Сбербанка/ТБанка).
- **Тесты** на новые функции (+19): парсер архивов, `pickContextLength`,
  `formatLlmError`.
- **Авто-выгрузка скиллов при `checkpoint`** — после сжатия истории все
  загруженные скиллы снимаются (модель перезагрузит если нужны для
  следующей фазы). Раньше они продолжали инжектиться в каждый turn и
  засоряли контекст.
- Системный промт усилен в нескольких местах:
  - **«Сказал — сделал в этом же ходу.»** Текст вида «сейчас проверю»,
    «начну с» обязан сопровождаться tool_call в том же turn'е, иначе
    стрим зависает на обещании.
  - **«Запустил фоновую задачу — заверши ход и жди.»** После `ssh_exec_async`
    не циклить `job_status` — 1 проверка, короткий ответ юзеру, стрим
    завершить. Сервер автоматически пнёт через `[Система] Фоновая задача
    завершена…` когда job → `exited`. Это и экономит токены, и не даёт
    давать ответ на устаревшем кэше (`apt list --upgradable` до
    завершения `apt update`).
  - **«Пакет» в контексте контроллера WB = Debian-пакет (apt/dpkg).**
    Зависимости — через `apt-cache depends`, не через GitHub
    `package.json`.
  - **Описание скилла `diagrams`** триггерится явными ключевыми словами
    («диаграмма», «схема», «mermaid», «flowchart», «архитектура»…), чтобы
    модель загружала его при запросах визуализации.
  - **Пинок после `checkpoint`** — system-msg прямо просит продолжить
    задачу или дать финальный ответ, не виснуть на «дальше проверю».

### Changed
- При переключении провайдера в настройках авто-сохранение немедленно
  (как с auto-save API-ключа) — иначе info-эндпоинты возвращали 400.
  Окно настроек НЕ закрывается на авто-сохранении, только при явном
  «Сохранить» (новое событие `autoSaved`).
- Чекбокс «Клиентское авто-сжатие» теперь видим только у провайдеров с
  серверным сжатием (AITunnel/OpenRouter). У остальных клиентское
  сжатие принудительно вкл.
- Для AITunnel и OpenRouter общая логика: одна галочка переключает
  серверное сжатие провайдера ↔ клиентский checkpoint. Дефолт — серверное.
- Превью изображений + чипы файлов прижаты вправо (выровнены по
  user-message). Кнопка копирования у user/assistant — в правом верхнем
  углу bubble, появляется на hover, с подложкой в цвет соответствующего
  bubble. Раньше выглядела как квадрат поверх текста.
- Системный промт усилен: при пустом контексте и вопросе про ОДИН
  контроллер модель обязана уточнить какой именно (или подтвердить «на
  любом») — не выбирать первый из `list_controllers` по умолчанию.

### Fixed
- В dev-сборке Vite не пробрасывал WebSocket на `/api/ssh/<sn>/shell` —
  SSH-терминал не открывался. `ws: true` в `vite.config.ts`.
- `selectChat` инициализирует `liveTurns[id]` shallow-копией всей
  истории — раньше при отправке нового сообщения персистентная история
  могла исчезнуть из UI (live + 2 новых turns обгоняли persisted).
- Шапка чата (tokens / cost / context %) не обновлялась после стрима —
  computed читали `activeChat.turns`, который больше не пересоздаётся
  при in-place merge. Переключены на live с fallback.
- `selectChat` не дублирует user-msg при отправке через нажатие Enter
  на завершении предыдущего стрима (race fix: `streaming = false`
  снимается только после полной перезагрузки чата).
- `await nextTick()` после оптимистичной вставки в `liveTurns` — Vue
  гарантированно перерисует user-message до начала стрима, иначе при
  мгновенном ответе модели юзер видел всё разом.
- `runningJobs` обновляется только при реальной смене состава задач —
  раньше каждые 3 секунды массив пересоздавался и Vue ре-рендерил группы
  с running-баннером.
- `GET /api/chats/:id/jobs` больше не делает SSH `jobStatus` синхронно
  на каждый UI-tick. Состояние задач обновляется фоновым tracker'ом
  (`startJobTracker` в `jobs.ts`, опрос раз в 5с) — UI не висит на
  handshake-таймауте недоступного контроллера.
- SSH `HANDSHAKE_TIMEOUT` 15с (вместо 4с) + retry с backoff 5/10/20с
  только при handshake-таймауте. Свежезагруженный контроллер больше не
  выкидывает «Timed out while waiting for handshake».
- Title чата чистится от `[file:...]` токенов — раньше попадал прямо
  в название чата.
- Баннер ошибок: иконка ⚠, жирный заголовок, детали мелким шрифтом, URL
  кликабельные, кнопки «↻ Повторить» и «×» чтобы скрыть.

### Fixed
- В dev-сборке (`bun run dev:web` + `bun run dev:server`) SSH-терминал
  не открывался — Vite proxy не пробрасывал WebSocket-апгрейд на
  `/api/ssh/<sn>/shell`, и xterm.js получал «WebSocket error».
  Добавлен `ws: true` в `vite.config.ts`. На prod-сборке (один процесс)
  баг не воспроизводился — он касался только dev-окружения.
- Регресс из 0.13.3: после стрима персистентная история чата могла
  «исчезнуть» при отправке нового сообщения. `selectChat` инициализировал
  `liveTurns[id] = []` пустышкой, потом `prevHistory` через `??` брал
  пустой массив, и новый user-msg + assistant перезаписывали всю
  накопленную ленту. Теперь при выборе чата `liveTurns[id]` сразу
  заполняется shallow-копией всей истории (без system) — live становится
  единственным источником правды для рендера, не зависящим от
  `activeChat.turns`.
- Баннер ошибок в шапке чата стал читаемым: иконка ⚠, жирный
  заголовок («Недостаточно средств на счёте провайдера (402)»), детали
  мелким шрифтом, URL в тексте кликабельные, кнопка «×» чтобы скрыть.
  Раньше всё было одной длинной красной строкой.

## [0.13.3] — 2026-05-07

### Fixed
- Сообщение, отправленное по Enter в момент окончания ответа модели, больше
  не «теряется» и не появляется не на своём месте. Race condition в
  `sendMessage` finally: `streaming.value = false` ставился ДО
  `await api.getChat(id)` + `delete liveTurns[id]`, и юзер успевал
  нажать Enter в эту паузу — второй `sendMessage` создавал свой
  `liveTurns[id]`, который тут же затирался старым finally.
- User-сообщение могло отрисовываться вместе с первым ответом модели
  (когда модель отвечает мгновенно). Добавлен `await nextTick()` после
  оптимистичной вставки в `liveTurns` — Vue гарантированно перерисует
  баббл с user-message до начала стрим-ответа.
- Чат «дёргался» периодически в двух местах:
  - `refreshJobs()` каждые 3 секунды заменял `runningJobs.value` на новый
    array даже если состав не менялся — теперь обновление только при
    реальном изменении состояния задач.
  - После стрима делался полный `patchLocalChat(c)` — `activeChat.value`
    подменялся новым объектом, ChatMessageList перерендеривал
    markdown/highlight/mermaid. Теперь in-place обновляются только
    counters + tokens на последнем assistant turn; live-state остаётся
    источником правды до переключения чата.
- SSH handshake-таймаут к свежезагруженному контроллеру:
  `Timed out while waiting for handshake`. Раньше использовался один
  `CONNECT_TIMEOUT = 4 с`, на armv7 после reboot RSA-3072 init не
  успевал. Введён отдельный `HANDSHAKE_TIMEOUT = 15 с` + retry с backoff
  5/10/20 с (только при handshake-таймауте, auth-ошибки не ретраются).

### Changed
- Textarea ввода НЕ блокируется во время ответа модели — юзер может
  набирать следующий вопрос. Если нажать Enter пока модель ещё пишет —
  под полем ввода появляется мягкая подсказка: «Модель ещё отвечает.
  Дождись её ответа и нажми Enter ещё раз — или нажми «■ Прервать», и
  можно будет отправить сразу.» Введённый текст сохраняется.

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

[Unreleased]: https://github.com/wirenboard/wb-ai-helper-desktop/compare/v0.13.20...HEAD
[0.13.20]: https://github.com/wirenboard/wb-ai-helper-desktop/compare/v0.13.19...v0.13.20
[0.13.19]: https://github.com/wirenboard/wb-ai-helper-desktop/compare/v0.13.18...v0.13.19
[0.13.18]: https://github.com/wirenboard/wb-ai-helper-desktop/compare/v0.13.17...v0.13.18
[0.13.17]: https://github.com/wirenboard/wb-ai-helper-desktop/compare/v0.13.16...v0.13.17
[0.13.16]: https://github.com/wirenboard/wb-ai-helper-desktop/compare/v0.13.15...v0.13.16
[0.13.15]: https://github.com/wirenboard/wb-ai-helper-desktop/compare/v0.13.14...v0.13.15
[0.13.14]: https://github.com/wirenboard/wb-ai-helper-desktop/compare/v0.13.13...v0.13.14
[0.13.13]: https://github.com/wirenboard/wb-ai-helper-desktop/compare/v0.13.12...v0.13.13
[0.13.12]: https://github.com/wirenboard/wb-ai-helper-desktop/compare/v0.13.11...v0.13.12
[0.13.11]: https://github.com/wirenboard/wb-ai-helper-desktop/compare/v0.13.10...v0.13.11
[0.13.10]: https://github.com/wirenboard/wb-ai-helper-desktop/compare/v0.13.9...v0.13.10
[0.13.9]: https://github.com/wirenboard/wb-ai-helper-desktop/compare/v0.13.8...v0.13.9
[0.13.8]: https://github.com/wirenboard/wb-ai-helper-desktop/compare/v0.13.7...v0.13.8
[0.13.7]: https://github.com/wirenboard/wb-ai-helper-desktop/compare/v0.13.6...v0.13.7
[0.13.6]: https://github.com/wirenboard/wb-ai-helper-desktop/compare/v0.13.5...v0.13.6
[0.13.5]: https://github.com/wirenboard/wb-ai-helper-desktop/compare/v0.13.4...v0.13.5
[0.13.4]: https://github.com/wirenboard/wb-ai-helper-desktop/compare/v0.13.3...v0.13.4
[0.13.3]: https://github.com/wirenboard/wb-ai-helper-desktop/compare/v0.13.2...v0.13.3
[0.13.2]: https://github.com/wirenboard/wb-ai-helper-desktop/compare/v0.13.1...v0.13.2
[0.13.1]: https://github.com/wirenboard/wb-ai-helper-desktop/compare/v0.13.0...v0.13.1
[0.13.0]: https://github.com/wirenboard/wb-ai-helper-desktop/compare/v0.12.1...v0.13.0
