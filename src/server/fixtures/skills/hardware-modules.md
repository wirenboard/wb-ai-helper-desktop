# hardware-modules

Настройка внутренних модулей расширения и портов контроллера Wiren Board. Подгружай когда пользователь просит настроить, подключить или проверить: модуль расширения (MOD1-MOD4), WBIO (дискретный ввод-вывод), Zigbee-модуль, CAN, RS-232/RS-485, GPS, KNX, eBUS, OpenTherm, HDMI, аналоговые входы. Также если спрашивает про слоты, ttyMOD, wb-hardware.conf, модули расширения, или «какой модуль в каком слоте».

## Архитектура

- **Конфигурация:** `/etc/wb-hardware.conf` — JSON-файл, описывает какой модуль в каком слоте.
- **Сервис:** `wb-hwconf-manager` — читает конфиг и применяет Device Tree overlays через ядро. Прямого MQTT/RPC у него нет.
- **Правка:** через инструменты `get_hardware_config` / `save_hardware_config` (обёртки над confed/Editor RPC).
- **Веб-интерфейс:** Настройки → Модули расширения и порты.

## Слоты контроллера

| Слот | Порт | Назначение |
|------|------|------------|
| mod1–mod4 | `/dev/ttyMOD1`–`/dev/ttyMOD4` | Модули расширения (Zigbee, CAN, RS-232, RS-485, GPS, KNX, eBUS, OpenTherm, HDMI, аналоговые входы, и др.) |
| extio1–extio8 | GPIO | WBIO-модули дискретного ввода-вывода (реле, сухие контакты, SSR) |
| rs485-1, rs485-2 | `/dev/ttyRS485-1`, `/dev/ttyRS485-2` | Встроенные порты RS-485 (настройка терминатора) |
| w1, w2 | 1-Wire | Шины 1-Wire |
| wbc | — | Модем (2G/3G/4G/NB-IoT) |

## Инструменты

**Всегда используй эти инструменты — не вызывай mqtt_rpc(confed/Editor/Load) или mqtt_rpc(confed/Editor/Save) напрямую!**

```
get_hardware_config(sn=SN)
// Ответ: { configPath, content (объект конфига), schema (JSON Schema со всеми модулями и опциями) }
```

```
save_hardware_config(sn=SN, slot_id="mod1", module="wbe2-r-zigbee")
save_hardware_config(sn=SN, slot_id="mod1", module="wbe2-r-zigbee", options={...})
save_hardware_config(sn=SN, slot_id="mod1", module="")   // убрать модуль
```

`save_hardware_config` сам загружает текущий конфиг, изменяет нужный слот и сохраняет — передавать `content` не нужно.

**Что происходит при save_hardware_config:**
1. Confed валидирует JSON по схеме
2. Конвертирует в упрощённый формат и пишет `/etc/wb-hardware.conf`
3. Перезапускает `wb-hwconf-manager`
4. wb-hwconf-manager применяет/снимает Device Tree overlays
5. Перезапускает зависимые сервисы (wb-mqtt-gpio для WBIO, и др.)

**Это безопасная операция** — если JSON невалиден, Save вернёт ошибку и ничего не запишет.

## Сценарий: посмотреть текущую конфигурацию модулей

1. `get_hardware_config(sn=SN)`
2. Из `content` — покажи пользователю таблицу: слот → модуль → опции.
3. Из `schema` → `oneOf` — можно показать какие модули доступны для каждого слота.

## Сценарий: установить модуль в слот

**Шаг 0 — спроси пользователя в какой слот вставлен модуль физически.**
Не выбирай слот самостоятельно. Пользователь знает куда вставил модуль. Спроси явно:
> «В какой слот вставлен модуль физически? (mod1, mod2, mod3 или mod4)»

Только после ответа переходи к шагу 1.

Пример — поставить Zigbee в mod1:
```
// Шаг 1: узнай доступные модули и текущий конфиг
result = get_hardware_config(sn=SN)
// result.schema — список совместимых модулей для каждого слота

// Шаг 2: сохрани одним вызовом
save_hardware_config(sn=SN, slot_id="mod1", module="wbe2-r-zigbee")
```

1. `get_hardware_config(sn=SN)` — посмотри текущий конфиг и доступные модули.
2. Из `schema` определи корректное значение `module` для нужного типа модуля. Типичные значения:

| Модуль | Значение `module` |
|--------|-------------------|
| Zigbee (WBE2R-R-ZIGBEE) | `wbe2-i-zigbee` |
| CAN | `wbe2-i-can` |
| RS-232 | `wbe2-i-rs232` |
| RS-485 | `wbe2-i-rs485` |
| GPS | `wbe2-i-gps` |
| KNX | `wbe2-i-knx` |
| eBUS | `wbe2-i-ebus` |
| OpenTherm | `wbe2-i-opentherm` |
| HDMI | `wbe2-hdmi` |
| Аналоговые входы | `wbe2-i-analog` |
| Пусто (убрать модуль) | `""` |

> **Важно:** Точные идентификаторы модулей могут отличаться на разных ревизиях контроллеров. Всегда бери `module` из `schema`, а не из этой таблицы.

4. Покажи пользователю что именно меняется (было → стало).
5. После подтверждения — `save_hardware_config(sn=SN, slot_id=<id слота>, module=<module из schema>)`.
6. Проверь что порт появился:
```bash
ssh_exec(sn, "ls -la /dev/ttyMOD3")  # для mod3
```

## Сценарий: настроить WBIO-модуль

WBIO-модули (дискретный ввод-вывод) подключаются в слоты `extio1`–`extio8`. Типичные модули:
- `WBIO-DI-DR-16` — 16 входов сухих контактов
- `WBIO-DO-R10R-4` — 4 релейных выхода 10А
- `WBIO-DO-SSR-8` — 8 SSR-выходов
- `WBIO-AI-DV-12` — 12 аналоговых входов
- `WBIO-DO-OC-12` — 12 выходов открытый коллектор

1. `get_hardware_config(sn=SN)`
2. Найди слот `extioN` — в `schema` будут доступные WBIO-модули.
3. Установи `module` (например `"wbio-di-dr-16"`) — точное значение бери из schema.
4. `save_hardware_config(sn=SN, slot_id=<extioN>, module=<module из schema>)`
5. После сохранения wb-mqtt-gpio перезапустится и создаст устройства `/devices/wb-gpio/...`.
6. Проверь:
```bash
ssh_exec(sn, "systemctl is-active wb-mqtt-gpio")
```
```jsonc
mqtt_list_topics({ sn, prefix: "/devices/wb-gpio/controls" })
```

## Сценарий: настроить RS-485 порт

Встроенные порты RS-485 (`rs485-1`, `rs485-2`) — настройка терминатора:

1. `get_hardware_config(sn=SN)`
2. Найди слот `rs485-1` или `rs485-2` в `content`.
3. В `schema` посмотри допустимые значения `options.terminator` для этого слота.
4. `save_hardware_config(sn=SN, slot_id="rs485-1", module=<текущий module>, options={terminator: "on"})`

## Грабли

- **Не вызывай mqtt_rpc(confed/Editor/Load или Save) напрямую** — используй `get_hardware_config` / `save_hardware_config`. Без params.path confed вернёт ошибку.
- **Не правь `/etc/wb-hardware.conf` через write_file или ssh_exec** — только через `save_hardware_config`. Прямая запись обходит валидацию confed и не применит overlays.
- **Если save_hardware_config вернул ошибку** — сообщи пользователю, не пытайся обойти через ssh_exec или write_file.
- **Идентификаторы модулей** (`module`) зависят от ревизии платы. Всегда бери из `schema`, возвращённой `get_hardware_config`.
- **Модуль Zigbee не виден на странице Устройства** — это нормально. Zigbee-адаптер — не Modbus-устройство. Проверяй через wb-hardware.conf.
- **После установки модуля в слот** нужно настроить ПО: Zigbee → zigbee2mqtt (скилл `software-install`), CAN → wb-mqtt-can, и т.д.
- **WBIO-модули** — физически подключаются к разъёму на плате контроллера, настройка в wb-hardware.conf назначает слот.
- **Смена модуля в слоте** — старый модуль деинициализируется (overlay снимается), новый инициализируется. Безопасно, но устройства старого модуля пропадут.

## Документация

- Модули расширения: <https://wiki.wirenboard.com/wiki/Internal_modules>
- wb-hwconf-manager: <https://github.com/wirenboard/wb-hwconf-manager>
- WBIO: <https://wiki.wirenboard.com/wiki/WBIO>
- WBE2R-R-ZIGBEE: <https://wiki.wirenboard.com/wiki/WBE2R-R-ZIGBEE_v.2_ZigBee_Extension_Module>
