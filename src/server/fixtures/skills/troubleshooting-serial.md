# troubleshooting-serial

Программная диагностика serial-шины (RS-485, Modbus и другие протоколы) с уровня драйвера и MQTT. Подгружай при: ошибках Modbus, CRC, таймаутах, «устройство не отвечает», «данные не обновляются», медленном опросе, ошибках чтения/записи. **Сначала проверь `lsusb | grep -i owon` — если осциллограф OWON подключён, грузи вместо этого скилл `rs485-diagnose` (он неинвазивный, не ломает статистику драйвера). Программную диагностику подключай только если у инструментальной не получилось, или OWON не воткнут.**

**ВАЖНО: Действуй без пауз. НЕ спрашивай разрешение на каждый шаг — пользователь УЖЕ попросил диагностику, это и есть подтверждение. Выполняй ВСЕ шаги подряд: логи → debug → scan → здоровье. НЕ останавливайся с вопросами «хотите запустить debug?» или «если хочешь, я могу...» — просто делай. Отчёт — в конце. Лог сохрани через `write_file(sn, "/mnt/data/ai/wb-cloud-assistant/diag/serial-diag.txt", <отчёт>)`.**

## Начни с этого

1. **Документация по устройству** — всегда показывай URL источника. Последовательность:
   - `web_fetch("https://wirenboard.com/wiki/<DeviceModel>")` — страница устройства, раздел «Известные неисправности»
   - Если ничего не нашёл там — сразу пробуй веб-поиск по вики (домен менялся, пробуй оба): `web_search("site:wirenboard.com/wiki/ <DeviceModel> <ошибка>")` или `web_search("site:wiki.wirenboard.com <DeviceModel> <ошибка>")`
   - Смотри changelog устройства (`web_fetch` страницы changelog) — там часто есть ERRMODBUS-коды и исправленные баги
   - **Всегда цитируй URL**, откуда взял информацию
2. `systemctl is-active wb-mqtt-serial` — жив ли драйвер
3. Логи — масштаб и тип:
```bash
ssh_exec(sn, "journalctl -u wb-mqtt-serial -p warning --since '1 hour ago' --no-pager | grep -c 'failed to'; journalctl -u wb-mqtt-serial -p warning --since '1 hour ago' --no-pager | grep -oP 'device modbus:\\K\\d+' | sort | uniq -c | sort -rn; journalctl -u wb-mqtt-serial -p warning -n 15 --no-pager")
```
4. **Debug — raw-пакеты. ВЫПОЛНЯЙ СРАЗУ, НЕ СПРАШИВАЯ.** Это безопасная операция — `serial_debug_collect` сам включает и выключает debug, сам перезапускает драйвер. Вызывай тул немедленно после анализа логов.

Время debug: раздели 18000 на количество ошибок за час (из шага 3). Результат — секунды. Минимум 30, максимум 300. Если ошибок 0 — ставь 120.

Таблица:
- 10 ошибок/час → 18000/10 = 1800 → cap 300 сек
- 50 ошибок/час → 18000/50 = 360 → cap 300 сек
- 100 ошибок/час → 18000/100 = 180 сек
- 500 ошибок/час → 18000/500 = 36 сек
- 1000 ошибок/час → 18000/1000 = 18 → floor 30 сек

Вызови прямо сейчас: `serial_debug_collect(sn, durationSec)`. НЕ пиши «если хочешь, запущу debug» — ПРОСТО ВЫЗОВИ ТУЛ.

После завершения забери лог: `fetch_from_controller(sn, "/mnt/data/ai/wb-cloud-assistant/diag/debug-serial.log")`.

Если за 2 минуты ошибка не воспроизвелась — скажи пользователю: проблема редкая, debug выключен.

5. **Scan шины** — кто есть, кого нет, дубликаты. **Используй параметры из шага 3 (ports/Load).** Вызывай тул `wb_bus_scan` — он сам запустит скан, будет опрашивать прогресс и доставит результат через баннер:
```
wb_bus_scan(sn, port="/dev/ttyRS485-1", baud_rate=115200, parity="N", stop_bits=2)
```
Подставь реальные параметры порта! НЕ вызывай mqtt_rpc для bus-scan напрямую — используй только `wb_bus_scan`. Scan находит только WB и Onokom (Fast Modbus). Стороннее — только `modbus_client_rpc`.

6. **Здоровье WB-устройств** — питание и uptime (только для WB, определяй по scan):
```bash
ssh_exec(sn, "modbus_client_rpc -m rtu -a <slave> -t 3 -r 104 -c 2 -b <baud> -s <stop> -p <parity> <path> && modbus_client_rpc -m rtu -a <slave> -t 3 -r 121 -c 2 -b <baud> -s <stop> -p <parity> <path>")
```

## Версия прошивки устройства

Если нужна версия прошивки конкретного WB-устройства — **не спрашивай пользователя**, делай так:

1. Загрузи конфиг драйвера: `mqtt_rpc(sn, "wb-mqtt-serial", "config", "Load", {})`
2. Найди устройство по slave_id, запомни его `device_type` (например `WB-MDM3`)
3. Загрузи шаблон этого типа: `mqtt_rpc(sn, "wb-mqtt-serial", "templates", "GetTemplate", {"device_type": "<device_type>"})`
4. Среди каналов шаблона найди тот, у кого название напоминает версию прошивки: `FW Version`, `Firmware Version`, `SW Version`, `Serial` и т.п. — имя может быть любым, ищи по смыслу
5. В конфиге драйвера найди этот канал у нужного устройства и включи: `"enabled": true`
6. Сохрани конфиг: `mqtt_rpc({ sn, driver:"confed", service:"Editor", method:"Save", params:{ path:"/etc/wb-mqtt-serial.conf", content:"<полный конфиг>" } })`
7. Прочитай значение из MQTT: `mqtt_get(sn, "/devices/<device_id>/controls/<channel_name>")`

Пример: у `wb-mdm3_57` канал называется `FW Version`, у другого устройства может быть иначе — всегда смотри в шаблоне.

## Паттерны: увидел → делай

| Увидел | Делай |
|---|---|
| `invalid crc` в логах | Debug → смотри raw-пакет. CRC битый = помехи/контакт. Чужой slave_id = дубликат |
| `request timed out` | `device/Probe` → живо ли. Если молчит — физика, питание, slave_id |
| `invalid data size` | Scan → ищи дубликат slave_id. Debug → лишние байты = коллизия |
| `rate limit exceeded` | Разнести устройства по портам, увеличить baud, отключить лишние каналы |
| Устройство в scan но не в конфиге | Может мешать! Добавить или отключить физически |
| Устройство в конфиге но не в scan | Выключено, обрыв, или стороннее (scan не видит) |
| CRC у всех устройств | Помехи, терминатор 120 Ом, заземление. Эксперимент: снизить скорость |
| CRC у одного | Подключить коротким проводом. Если заработает — линия |
| Другие stop bits помогают | Несовпадение параметров порта и устройства |
| Мин. напряжение < 20В (рег. 122) | Просадки питания → блок питания, сечение провода |
| Маленький uptime (рег. 104-105) | Устройство перезагружалось → питание |
| Exception code в debug | 1=illegal FC, 2=illegal addr, 3=illegal value, 4=device failure |
| Протокол не Modbus в конфиге | modbus_client_rpc и scan не помогут, только логи и debug |

## Инструменты

**modbus_client_rpc** (приоритет) — через очередь драйвера, безопасен:
```bash
modbus_client_rpc -m rtu -a <slave> -t <FC> -r <reg> -c <count> -b <baud> -s <stop> -p <parity> <port>
```
FC: 1=coils, 2=discrete, 3=holding, 4=input, 5=write coil, 6=write reg, 15=write coils, 16=write regs.

**device/Probe** — быстрая проверка "живо ли":
```
mqtt_rpc(sn, "wb-mqtt-serial", "device", "Probe", {"path":"..","baud_rate":..,"data_bits":..,"parity":"..","stop_bits":..,"slave_id":..,"total_timeout":10000})
```

**ports/Load** — параметры портов:
```
mqtt_rpc(sn, "wb-mqtt-serial", "ports", "Load", {})
```

**wb-modbus-scanner** — Fast Modbus утилита (WB, Onokom). `apt install wb-modbus-ext-scanner`. Конфликтует с драйвером — HITL.
```bash
wb-modbus-scanner -d <port> -b <baud>        # scan
wb-modbus-scanner -d <port> -s <sn> -i <id>  # смена slave_id
```

**modbus_client** — прямой доступ. Конфликтует с драйвером — HITL.

## Полезные регистры WB-устройств

| Регистр | Что | Формат |
|---|---|---|
| 104-105 | Uptime | u32, секунды |
| 110 | Baud rate | u16, сокращённо: 96=9600, 1152=115200 |
| 121 | Напряжение питания | u16, мВ |
| 122 | Мин. напряжение | u16, мВ (с момента загрузки) |
| 128 | Slave ID | u16 |
| 200-205 | Модель | string |
| 270-271 | Серийный номер | u32 |

Broadcast запись (slave_id 0) — сменить baud/адрес всем WB на шине разом.

baud_rate `1152` = `115200` — сокращённая запись, НЕ ошибка.

## Эксперименты (бэкап + HITL)

Перед экспериментами: `ssh_exec(sn, "cp /etc/wb-mqtt-serial.conf /etc/wb-mqtt-serial.conf.bak-$(date +%s)")`

- **Stop bits**: попробовать 1 и 2 через `modbus_client_rpc -s 1` / `-s 2`
- **Скорость**: broadcast `modbus_client_rpc -a 0 -t 6 -r 110 ... 96` → смена порта через confed. Пропали ошибки = кабель/терминация
- **Изоляция**: `config/Load` → `"enabled": false` → `confed/Editor/Save`. Пропали ошибки у остальных = это устройство мешает
- **Таймауты**: `response_timeout_ms`, `guard_interval_us` в конфиге порта

**Всё вернуть обратно после экспериментов.**

## Грабли

- `modbus_client`/`wb-modbus-scanner` без остановки драйвера → ложные ошибки
- Debug забыт → диск заполнится
- port/Scan → только WB и Onokom
- Неправильный baud → молчит СОВСЕМ. Неправильные stop bits → плавающие ошибки
- RS-485 звездой работает на коротких расстояниях; при проблемах — рекомендуй цепочку

## Документация

- <https://wiki.wirenboard.com/wiki/RS-485>
- <https://wiki.wirenboard.com/wiki/Modbus>
- <https://wiki.wirenboard.com/wiki/Common_Modbus_Registers>
- <https://wiki.wirenboard.com/wiki/How_to_diagnose>
- <https://github.com/wirenboard/wb-modbus-ext-scanner/blob/main/docs/protocol.ru.md>
