# wb-serial-templates

Создание собственных Modbus-шаблонов для `wb-mqtt-serial`. Нужно когда производитель не WB/Onokom (нет встроенного шаблона) или когда добавляешь свои регистры в существующий.

Подгружай на: «нет шаблона для устройства», «добавь стороннее Modbus-устройство», «создать шаблон», «как добавить кастомные регистры», «шаблон для счётчика электроэнергии», «Modbus-термометр».

## Где живут шаблоны

| Каталог | Что | Редактируемый? |
|---|---|---|
| `/usr/share/wb-mqtt-serial/templates/config-<id>.json` | Шаблоны WB и Onokom (пакетные) | НЕТ — перезаписываются `apt upgrade` |
| `/etc/wb-mqtt-serial.conf.d/templates/<имя>.json` | Кастомные шаблоны | Да, переживают апгрейд |
| `/etc/wb-mqtt-serial.conf.d/confs/*.conf` | Кастомные куски основного конфига | Реже |

`wb-mqtt-serial` сканирует обе директории при старте. Кастомный шаблон с тем же `device_type`, что и пакетный, **перекрывает** пакетный (полезно для патчей; рискованно — забудешь).

## Минимальный шаблон

```json
{
  "title": "ACME EM-100 (1-phase energy meter)",
  "device_type": "ACME-EM100",
  "group": "g_energy_meters",
  "device": {
    "name": "ACME EM-100",
    "id": "acme-em100",
    "channels": [
      {"name": "Voltage", "reg_type": "input", "address": 0, "format": "u16", "scale": 0.1, "type": "voltage", "units": "V"},
      {"name": "Current", "reg_type": "input", "address": 2, "format": "u32", "scale": 0.001, "type": "current", "units": "A"}
    ]
  }
}
```

`device_type` идёт в `/etc/wb-mqtt-serial.conf` (`ports[*].devices[*].device_type`).
`device.id` — префикс MQTT-топика (`/devices/<id>_<slave_id>/...`).

## Поля канала (полный набор)

| Поле | Назначение |
|---|---|
| `name` | Имя контрола в MQTT (пробелы можно: `Input 0 counter`) |
| `reg_type` | `coil` (FC1, RW), `discrete` (FC2, RO), `holding` (FC3, RW), `input` (FC4, RO) |
| `address` | Адрес регистра (десятичный) |
| `format` | `u8/s8/u16/s16/u32/s32/u64/s64`, `bcd16/bcd32/bcd64`, `float`, `double`, `string`, `varstring` |
| `scale` | Множитель: `value = raw * scale` |
| `offset` | Прибавляется после scale |
| `round_to` | Округление до N знаков |
| `type` | Тип контрола: `switch`, `value`, `voltage`, `current`, `power`, `energy_power`, `temperature`, `pressure`, `range`, `text`, `pushbutton` |
| `units` | Единицы (V, A, °C, kWh) |
| `error_value` | Если raw == это, контрол публикуется с ошибкой |
| `unsupported_value` | Если raw == это, контрол не публикуется |
| `read_rate_limit_ms` | Не опрашивать чаще раза в N мс (для медленных регистров) |
| `enabled` | `false` — канал есть в шаблоне, но выключен по умолчанию |
| `readonly` | `true` — даже для `holding`/`coil` только чтение |
| `sporadic` | `true` — не запрашивать при первом старте |
| `condition` | Выражение по `parameters` — канал виден только если true |
| `group` | ID группы для UI |
| `word_order` | `big_endian` (default) или `little_endian` для multi-register |

### Endianness

Modbus байты big-endian, но **порядок слов** (16-битных регистров) у u32/s32/float часто little-endian. Симптом: значение «прыгает» — попробуй `"word_order": "little_endian"`.

### `string` / `varstring`

```json
{"name": "FW Version", "reg_type": "input", "address": 250, "format": "string", "size": 8, "type": "text"}
```

`size` — длина в регистрах (= 16 байт). `varstring` — переменной длины с null-терминатором.

## `parameters` — настройки прошивки

Регистры, которые UI показывает как «настройки устройства» (не телеметрию):

```json
"parameters": [
  {
    "id": "in0_mode",
    "title": "Input 0 mode",
    "address": 1100,
    "reg_type": "holding",
    "format": "u16",
    "default": 0,
    "enum": [0, 1, 2, 3],
    "enum_titles": [{"en": "Switch"}, {"en": "Push button"}, {"en": "RS-trigger"}, {"en": "Counter"}],
    "group": "g_in0_setup"
  }
]
```

`condition` в канале может смотреть на параметр по `id`: `"condition": "in0_mode==3"` — канал виден только если параметр == 3.

## `groups` — группировка в UI

```json
"groups": [
  {"id": "g_inputs", "title": "Inputs"},
  {"id": "g_in0_channels", "title": "Input 0", "group": "g_inputs"},
  {"id": "g_in0_setup", "title": "Input 0 setup", "group": "g_inputs"}
]
```

`group` ссылается на родительский `id`. Web-UI рендерит раскрываемые секции.

## `translations` — i18n

```json
"translations": {
  "ru": {
    "Voltage": "Напряжение",
    "Input 0": "Вход 0",
    "g_inputs": "Входы"
  }
}
```

## Workflow создания шаблона

1. **Документация устройства** — `WebFetch` инструкции производителя (таблица регистров: адреса, типы, scale). Без неё шаблон не делай — гадание = бесконечный дебаг.

2. **Скопируй похожий пакетный шаблон как стартер**:

```bash
ssh root@<HOST> 'cp /usr/share/wb-mqtt-serial/templates/config-wb-mr6c.json /etc/wb-mqtt-serial.conf.d/templates/acme-em100.json'
```

Минимум: поменяй `device_type`, `device.id`, `device.name`, `title`, потом перепиши `channels` под свою таблицу регистров.

3. **Проверь на одном канале**. Сначала шаблон с **одним** каналом. Добавь устройство в `/etc/wb-mqtt-serial.conf` через confed, проверь публикацию:

```bash
ssh root@<HOST> "mosquitto_sub -t '/devices/<device.id>_<slave_id>/controls/<channel>' -C 1 -W 5"
```

Если значение не такое — крути `format`, `scale`, `word_order`. Прямой замер через `modbus_client_rpc` (см. `/wb-troubleshooting-serial`).

4. **Расширяй пачками 5–10** каналов, после каждой — проверка через MQTT.

5. **Parameters и groups** — после того, как телеметрия работает.

6. **В git и в `/wb-controller-backup`** — кастомный шаблон не переживает FIT, бэкап подцепляет `/etc/wb-mqtt-serial.conf.d/` сам.

## Применение и логи

```bash
ssh root@<HOST> 'systemctl restart wb-mqtt-serial'
ssh root@<HOST> 'journalctl -u wb-mqtt-serial -n 50 --no-pager | grep -iE "(template|<device.id>)"'
```

Ошибки типа `Failed to parse template` / `Unknown register type` — синтаксис.

## Пример: 1-фазный счётчик электроэнергии

| Адрес | Reg | Format | Scale | Что |
|---|---|---|---|---|
| 0–1 | input | u32 | 0.1 | Voltage (mV→V) |
| 2–3 | input | u32 | 0.001 | Current (mA→A) |
| 4–5 | input | s32 | 0.01 | Active power (W) |
| 6–7 | input | u32 | 0.001 | Active energy (Wh→kWh) |

```json
{
  "title": "ACME EM-100",
  "device_type": "ACME-EM100",
  "group": "g_energy_meters",
  "device": {
    "name": "ACME EM-100",
    "id": "acme-em100",
    "channels": [
      {"name": "Voltage", "reg_type": "input", "address": 0, "format": "u32", "scale": 0.1, "type": "voltage", "units": "V"},
      {"name": "Current", "reg_type": "input", "address": 2, "format": "u32", "scale": 0.001, "type": "current", "units": "A"},
      {"name": "Active Power", "reg_type": "input", "address": 4, "format": "s32", "scale": 0.01, "type": "power", "units": "W"},
      {"name": "Active Energy", "reg_type": "input", "address": 6, "format": "u32", "scale": 0.001, "type": "energy_power", "units": "kWh"}
    ]
  }
}
```

## Грабли

- **Шаблон в `/usr/share/wb-mqtt-serial/templates/`** — перезапишется на апгрейде. Только `/etc/wb-mqtt-serial.conf.d/templates/`.
- **Endianness** — самая частая ошибка для u32/s32/float. Значение прыгает на множитель 65535 — `word_order: little_endian`.
- **Scale в обратную сторону** — производитель иногда пишет «raw / 10» вместо «raw × 0.1». Решается тестом на одном канале.
- **Дубль `device_type`** — если совпал с пакетным, тихо перекрывает. Префикс типа `ACME-` помогает.
- **Кириллица в `device.id`** — запрещена (попадает в имя топика). Только `[a-z0-9-]`.
- **0-based vs 1-based адреса** — стандарт Modbus 0-based, многие мануалы пишут 1-based. Сверяйся со спекой устройства.
- **Без `error_value`** — если устройство возвращает FFFF при «нет данных», MQTT покажет 65535 как валидное значение.

## Документация

- Формат шаблона: https://github.com/wirenboard/wb-mqtt-serial/blob/master/docs/template.md
- Modbus FC: https://modbus.org/docs/Modbus_Application_Protocol_V1_1b3.pdf
- Примеры — `/usr/share/wb-mqtt-serial/templates/` на контроллере (250+ шаблонов).
