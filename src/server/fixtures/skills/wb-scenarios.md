# wb-scenarios

`wb-scenarios` — отдельный движок поверх `wb-rules`, который генерирует JS-правила из декларативного JSON в `/etc/wb-scenarios.conf`. Это «no-code» слой для типовых задач: групповое управление устройствами, свет по движению, термостат, расписание.

Подгружай на: «сделай сценарий», «настрой термостат», «свет по датчику движения», «выключение по расписанию», `wb-scenarios.conf`, «сценарии в web UI».

**Граница:** полный JS со сложной логикой — `wb-rules` (defineRule, ES5). Сценарии — упрощённая надстройка для типичных кейсов. Если задача нестандартная или нужны вычисления — иди в wb-rules.

## Архитектура

```
/etc/wb-scenarios.conf   (через confed, JSON)
       │
       ▼
wb-scenarios-reloader.service
       │ (генерит .js под капотом)
       ▼
/etc/wb-rules/<generated rules>
       │
       ▼
wb-rules engine
```

Сервис: `wb-scenarios-reloader` (НЕ `wb-scenarios.service` — такого нет).

Schema: `/usr/share/wb-mqtt-confed/schemas/wb-scenarios.schema.json` — описывает 4 типа сценариев и UI.

## Четыре типа сценариев

### 1. `devicesControl` — групповое управление

«Когда контрол A меняется → выставить контролы B и C». Базовая автоматизация.

```json
{
  "scenarioType": "devicesControl",
  "name": "Свет в коридоре",
  "id_prefix": "corridor_light",
  "enable": true,
  "inControls": [
    {"deviceId": "wb-mwac_25", "controlId": "Input 1"}
  ],
  "outControls": [
    {"deviceId": "wb-mr6c_2", "controlId": "K1", "value": true}
  ]
}
```

`inControls` — триггеры (изменение значения), `outControls` — что выставить с каким значением.

### 2. `lightControl` — свет

Включение по датчику движения с off-таймером, ночной режим, диммирование.

```json
{
  "scenarioType": "lightControl",
  "name": "Свет в санузле",
  "id_prefix": "wc_light",
  "enable": true,
  "motionSensor": {"deviceId": "wb-msw-v4_20", "controlId": "Motion"},
  "lightOutput": {"deviceId": "wb-mr6c_2", "controlId": "K2"},
  "delayOff": 60,
  "ambientLightSensor": {"deviceId": "wb-msw-v4_20", "controlId": "Illuminance"},
  "darkThreshold": 100
}
```

### 3. `thermostat` — термостат

Включение нагревателя по разнице setpoint−current с гистерезисом.

```json
{
  "scenarioType": "thermostat",
  "name": "Гостиная",
  "id_prefix": "living_room",
  "enable": true,
  "temperatureSensor": {"deviceId": "wb-msw-v4_20", "controlId": "Temperature"},
  "heaterOutput": {"deviceId": "wb-mr6c_2", "controlId": "K3"},
  "setpoint": 22.0,
  "hysteresis": 0.5
}
```

### 4. `schedule` — расписание

«Каждый день в HH:MM делать X». Под капотом — wb-rules cron.

```json
{
  "scenarioType": "schedule",
  "name": "Полив",
  "id_prefix": "watering",
  "enable": true,
  "schedule": {"hour": 6, "minute": 30, "days": [1,2,3,4,5,6,7]},
  "actions": [
    {"deviceId": "wb-mr6c_2", "controlId": "K4", "value": true},
    {"deviceId": "wb-mr6c_2", "controlId": "K4", "value": false, "delay": 1800}
  ]
}
```

`days` — `[1..7]` (1=Пн … 7=Вс). `delay` — задержка после предыдущего action (сек).

## Базовые команды

```bash
ssh root@<HOST> 'cat /etc/wb-scenarios.conf'                                # текущий
ssh root@<HOST> 'systemctl status wb-scenarios-reloader --no-pager'         # статус
ssh root@<HOST> 'journalctl -u wb-scenarios-reloader -n 30 --no-pager'      # логи
ssh root@<HOST> 'ls /etc/wb-rules/wb-scenario-*.js 2>/dev/null'             # сгенерённые .js
```

После правки конфига `wb-scenarios-reloader` пересоздаёт правила и рестартит `wb-rules`. Через `mqtt_rpc confed/Editor/Save` (см. `wb-mqtt-serial` — там общий confed-паттерн) — рестарт автоматический; через `write_file` — нужно `systemctl restart wb-scenarios-reloader` руками.

## Когда сценария мало — иди в wb-rules

- Условие зависит от нескольких контролов одновременно с логикой.
- Нужно вычисляемое значение (среднее, ассиметричный гистерезис, ПИД).
- Нужно состояние (счётчики, триггер «N раз подряд»).
- Нужны таймеры кроме расписания (interval, exponential delay).
- Виртуальные устройства.

Сценарии хороши для «нажал кнопку → включил реле» и «по таймеру включил/выключил». За пределами этого — wb-rules.

## Грабли

- **`wb-scenarios.service` не существует** — сервис называется `wb-scenarios-reloader`.
- **Дублирование `id_prefix`** — два сценария с одинаковым `id_prefix` сгенерят пересекающиеся имена правил, конфликт.
- **Прямая правка `/etc/wb-rules/wb-scenario-*.js`** — перезаписывается при следующем reload'е. Только через `wb-scenarios.conf`.
- **Кириллица в `id_prefix`** — schema запрещает (regex `^[0-9a-zA-Z_]+$`). В `name` — можно.
- **Сценарий не появился в веб-UI** — проверь `journalctl -u wb-scenarios-reloader` на parse errors. Битый конфиг — UI ничего не показывает.
- **Сценарий и аналогичное wb-rules-правило** — конфликт (оба пишут в один контрол). Не дублируй.
- **`schedule` без timezone** — использует системный (`timedatectl`). После апгрейда tz сценарии могут «сдвинуться».

## Документация

- WB wiki — сценарии: https://wirenboard.com/wiki/Wb-scenarios
- Schema: `/usr/share/wb-mqtt-confed/schemas/wb-scenarios.schema.json` на контроллере.
