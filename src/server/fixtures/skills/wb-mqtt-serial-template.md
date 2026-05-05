# wb-mqtt-serial-template

Создание кастомного JSON-шаблона устройства для wb-mqtt-serial, когда прибор не найден во встроенных шаблонах контроллера. Подгружай на: «добавь устройство по документации», «устройства нет в шаблонах», «составь шаблон для Modbus устройства», «нет шаблона для X», «напиши описание регистров», «создай template для wb-mqtt-serial», «регистры из даташита».

**Граница:** если шаблон уже есть и нужно включить/отключить каналы или добавить устройство в конфиг — это скилл `wb-mqtt-serial`. Этот скилл только для создания нового шаблона с нуля.

## Главный путь

1. **Сначала ищи встроенный шаблон** — не угадывай, смотри на контроллере:
   ```
   ssh_exec(sn, "ls /usr/share/wb-mqtt-serial/templates/ | grep -i <имя>")
   ```
   Если не нашёл — `web_search` по названию модели + "wb-mqtt-serial template".

2. **Запроси даташит** у пользователя. Нужно: функциональные коды (FC01–FC04), адреса регистров, тип данных, масштаб, байтовый порядок.

3. **Прозондируй регистры до написания шаблона** через `modbus_client_rpc` — убедись что адреса существуют и значения разумные. Делай это при живом устройстве на шине:
   ```
   ssh_exec(sn, "modbus_client_rpc -m rtu -a <slave_id> -t 3 -r <address> -c <count> -b <baud> -s <stop> -p <parity> <port>")
   ```
   FC: `1`=coils, `2`=discrete, `3`=holding, `4`=input. Сразу проверяй масштаб — raw / scale должен давать ожидаемое значение.

4. **Составь JSON** по структуре ниже.

5. **Запиши шаблон на контроллер:**
   ```
   write_file(sn, "/etc/wb-mqtt-serial.conf.d/templates/my-device.json", "<json>")
   ```

6. **Проверь что шаблон подхватился через RPC:**
   ```
   mqtt_rpc({ sn, driver:"wb-mqtt-serial", service:"device", method:"LoadConfig",
     params: { path:"/dev/ttyRS485-1", baud_rate:9600, parity:"N",
               data_bits:8, stop_bits:2, slave_id:1, device_type:"my-device" }
   })
   ```

7. **Добавь устройство в конфиг** через `confed/Editor/Save` — см. скилл `wb-mqtt-serial`.

## Структура шаблона

```json
{
  "device_type": "my-device",
  "device": {
    "name": "Vendor Model",
    "id": "my-device",
    "max_reg_hole": 10,
    "max_read_registers": 60,
    "guard_interval_us": 1000,
    "channels": []
  }
}
```

- `device_type` — используется в `wb-mqtt-serial.conf` как `"device_type": "my-device"`
- `id` — префикс MQTT-топика: `/devices/my-device_<slave_id>/...`
- `max_reg_hole` — допустимый пропуск в адресах при группировке запросов (0 = отключено)
- `guard_interval_us` — пауза между запросами мкс (увеличь для медленных устройств)

## Поля канала

```jsonc
{
  "name": "Temperature",      // Название в UI и MQTT
  "reg_type": "holding",      // coil | discrete | holding | input
  "address": 100,             // Адрес регистра (десятичный, 0-based)
  "type": "temperature",      // Тип виджета (см. ниже)
  "format": "s16",            // u16 | s16 | u32 | s32 | float | double
  "scale": 0.1,               // value = raw * scale + offset
  "offset": 0,
  "units": "°C",             // Для type:"value" — физическая единица
  "readonly": true,
  "enabled": true,            // false — канал скрыт, не опрашивается по умолчанию
  "poll_interval": 10000,     // мс между опросами
  "word_order": "big_endian", // Для 32-бит: big_endian | little_endian
  "max": 100, "min": 0       // Для type:"range"
}
```

Типы виджетов: `value`, `switch`, `alarm`, `pushbutton`, `range`, `text`,
`temperature`, `rel_humidity`, `atmospheric_pressure`, `voltage`, `current`,
`power`, `power_consumption`, `energy`, `lux`, `concentration`, `wind_speed`.

## FC → reg_type

| FC (даташит) | reg_type | Доступ |
|---|---|---|
| FC01 | coil | R/W, 1 бит |
| FC02 | discrete | RO, 1 бит |
| FC03 | holding | R/W, 16-бит |
| FC04 | input | RO, 16-бит |

## Типовые снипеты

```jsonc
// Дискретный вход (FC02)
{ "name": "DI 1", "reg_type": "discrete", "address": 0, "type": "switch", "readonly": true }

// Реле (FC01)
{ "name": "DO 1", "reg_type": "coil", "address": 0, "type": "switch" }

// Температура 0.1°C, signed (FC03)
{ "name": "Temperature", "reg_type": "holding", "address": 0,
  "type": "temperature", "format": "s16", "scale": 0.1, "readonly": true }

// Напряжение, uint16, scale 0.01 (FC03)
{ "name": "Voltage", "reg_type": "holding", "address": 10,
  "type": "voltage", "format": "u16", "scale": 0.01, "readonly": true }

// 32-бит счётчик, little-endian (FC03)
{ "name": "Counter", "reg_type": "holding", "address": 100,
  "type": "value", "format": "u32", "word_order": "little_endian", "readonly": true }

// Уставка с записью (FC03)
{ "name": "Threshold", "reg_type": "holding", "address": 200,
  "type": "range", "format": "s16", "min": 0, "max": 1000 }
```

## Отладка шаблона

**Ошибки валидации** — после `LoadConfig` или в журнале:
```
ssh_exec(sn, "journalctl -u wb-mqtt-serial -n 100 --no-pager | grep -iE 'error|invalid|template|schema'")
```
Типичные тексты ошибок:
- `Missing required property 'input_N_mode'` — шаблон не описал обязательные параметры устройства; нужен `setup[]` блок с дефолтами или полное описание из встроенного шаблона
- `Unknown device type` — `device_type` в шаблоне не совпадает с тем, что в конфиге; проверь написание
- `Invalid address` — адрес вне диапазона 0–65535 или не integer

**Значение читается, но неверное** — проверь raw через `modbus_client_rpc` и пересчитай scale/offset вручную. Если raw бред — скорее всего `word_order`: поменяй `big_endian` ↔ `little_endian`.

**Устройство не отвечает совсем** (timeout, CRC) — это не проблема шаблона, это RS-485/физика. Загрузи скилл `troubleshooting-serial`.

## Грабли

- **Адреса 1-based в даташите**: `40001` = holding регистр 0, `10001` = discrete 0. Всегда вычитай 1.
- **Байтовый порядок**: дефолт `big_endian`. Если 32-бит значения бредовые — `"word_order": "little_endian"`.
- `format` не нужен для `coil`/`discrete` — они всегда 1 бит.
- `max_reg_hole: 0` при разрозненных адресах → каждый канал отдельный запрос → медленный опрос.
- Кастомный шаблон только в `/etc/wb-mqtt-serial.conf.d/templates/` — в `/usr/share/...` перезапишется апдейтом.
- После `write_file` **файла шаблона** (`/etc/wb-mqtt-serial.conf.d/templates/*.json`) перезапуск не нужен — шаблон подхватится при следующем `LoadConfig`. Но `write_file` основного конфига (`wb-mqtt-serial.conf`) требует рестарта — делай через `confed/Editor/Save`.
- Если на порту несколько устройств — validation требует полных параметров (баг wb-mqtt-serial): бери их из встроенного шаблона через `device/LoadConfig` для похожего устройства.
- Не проверял регистры `modbus_client_rpc` до написания шаблона → потратишь время на несуществующие адреса.

## Документация

- Формат шаблонов: <https://github.com/wirenboard/wb-mqtt-serial/blob/main/README.md>
- Примеры шаблонов: <https://github.com/wirenboard/wb-mqtt-serial/tree/main/templates>
- Wiki: <https://wirenboard.com/wiki/wb-mqtt-serial>
