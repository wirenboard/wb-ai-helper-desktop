# wb-mqtt-serial

Драйвер Modbus/RS-485. Конфиг `/etc/wb-mqtt-serial.conf`, шаблоны `/usr/share/wb-mqtt-serial/templates/` (пакетные, не трогай) и `/etc/wb-mqtt-serial.conf.d/templates/` (свои). Доступ через RPC `wb-mqtt-serial/...`, не через файлы. Подгружай на: «канал не публикуется», «не вижу устройство на шине», «опрос замер», «включи канал X», «просканируй шину», «slave_id / холдинг / coil / input регистр», включение/отключение каналов существующих устройств.

**Граница скиллов:** если нужно создать шаблон для устройства которого нет в встроенных — это скилл `wb-mqtt-serial-template`. Если проблема с сигналом/CRC/таймаутами — `troubleshooting-serial` (или `rs485-diagnose` если есть OWON).

## RPC, не файлы

Шаблон с прошивки → `device/LoadConfig`. Конфиг → `config/Load`. Запись → `confed/Editor/Save` (валидация + рестарт сервиса атомарно; битый JSON не пишется, опрос шины жив). Прямой `write_file` в `.conf` — только с бэкапом и осознанно.

- **«Канала нет в MQTT» ≠ «не поддерживается».** Многие каналы шаблонов идут с `"enabled": false` (Uptime, Counter, Total, Serial). Сначала `device/LoadConfig`, потом выводы.
- **Шаблон ищи на контроллере, не на GitHub.** На железке — актуальный под прошивку. `web_fetch` шаблонов почти всегда зря.
- **Кастомный шаблон — последнее средство.** Сначала проверь встроенный.
- **Скан шины медленный.** `port/Scan mode=all` идёт 5-30 сек, ставь `timeoutSec ≥ 30`.

## RPC через mqtt_rpc

`params` — вложенный объект, обязательное поле (даже пустой `{}`).

```jsonc
// Шаблон устройства — все каналы, включая enabled:false
mqtt_rpc({ sn, driver: "wb-mqtt-serial", service: "device", method: "LoadConfig",
  params: { device_id: "wb-mr6c_138" }
  // или по адресу: { path: "/dev/ttyRS485-1", baud_rate: 9600, parity: "N",
  //                  data_bits: 8, stop_bits: 2, slave_id: 138, device_type: "WB-MR6C" }
})

// Текущий конфиг
mqtt_rpc({ sn, driver: "wb-mqtt-serial", service: "config", method: "Load", params: {} })

// Сохранить конфиг (валидация + рестарт)
mqtt_rpc({ sn, driver: "confed", service: "Editor", method: "Save",
  params: { path: "/etc/wb-mqtt-serial.conf", content: "<обновлённый JSON целиком>" }
})

// Скан шины (Fast Modbus)
mqtt_rpc({ sn, driver: "wb-mqtt-serial", service: "port", method: "Scan",
  params: { path: "/dev/ttyRS485-1", baud_rate: 9600, mode: "all" }, timeoutSec: 30
})

// Точечная проверка slave_id
mqtt_rpc({ sn, driver: "wb-mqtt-serial", service: "port", method: "Probe",
  params: { path: "/dev/ttyRS485-1", baud_rate: 9600, slave_id: 138 }
})
```

Прочее: `device/Load` — живые значения каналов; `device/Set` — записать `{"channel_name": value}` (только по явной просьбе пользователя).

## Сценарий «включи канал X на устройстве Y»

1. `mqtt_list_topics(sn, prefix="/devices/+/meta/name")` — найди `device_id`.
2. `device/LoadConfig({device_id})` — все каналы и их `enabled`.
3. `config/Load({})` — найди устройство в `ports[*].devices[*]`.
4. Правь JSON — добавь/обнови запись канала, поставь `"enabled": true`.
5. Покажи пользователю diff, предупреди про рестарт wb-mqtt-serial (опрос замрёт ~5-10 сек).
6. `confed/Editor/Save` с полным новым JSON.
7. Через 10-20 сек: `mqtt_read(sn, "/devices/<device_id>/controls/<channel>")`.

## Сценарий «что подключено на шине»

1. Порты: `ssh_exec(sn, "ls /dev/ttyRS485-* /dev/ttyMOD*")` или из `config/Load`.
2. `port/Scan` (`wb-mqtt-serial/port/Scan`) с `timeoutSec=30` на каждом порту — показывает что видит драйвер. Находит только WB и Onokom (Fast Modbus).
3. Сравни с `config/Load` — что уже описано, что добавить.

> `port/Scan` (этот скилл) — управленческий инструмент драйвера. `wb_bus_scan` (скилл `troubleshooting-serial`) — диагностический тул через `wb-device-manager`. Разные службы, разные цели — не путай.

## Прямая правка файла — бэкап обязателен

Если без `confed/Editor/Save` (через `write_file` или `ssh_exec`) — сначала бэкап, потом `systemctl restart wb-mqtt-serial`:

```bash
ssh_exec(sn, "cp /etc/wb-mqtt-serial.conf /etc/wb-mqtt-serial.conf.bak-$(date +%s)")
```

## Грабли

- «Канал не поддерживается» по `mqtt_list_topics` без `LoadConfig` — см. выше, `enabled:false` не публикуется.
- `web_fetch` шаблона с GitHub вместо `LoadConfig` — на железе актуальнее.
- Кастомный шаблон до проверки встроенного.
- Прямой `write_file` в `.conf` без валидации — битый JSON положит опрос шины.
- Правка пакетных шаблонов в `/usr/share/...` — перезапишутся апдейтом. Кастом — только в `/etc/wb-mqtt-serial.conf.d/templates/`.
- `port/Scan` без `timeoutSec ≥ 30` → таймаут, частичный ответ.

## Документация

- Wiki: <https://wirenboard.com/wiki/wb-mqtt-serial>
- Исходники + шаблоны: <https://github.com/wirenboard/wb-mqtt-serial>
- Страницы модулей: `https://wirenboard.com/wiki/<Модель>` (WB-MR6C, WB-MSW_v.4 и т.п.)
