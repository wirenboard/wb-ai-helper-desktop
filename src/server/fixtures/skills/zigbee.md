# zigbee

Zigbee-устройства на контроллере Wiren Board. Подгружай на «найди zigbee», «какие зигби устройства», «есть ли zigbee», «zigbee2mqtt», «0x00158d», «спарь устройство», «добавь зигби».

## Как опознать zigbee-устройство

Устройства с IEEE-адресами вида `0x00158d...`, `0x00124b...`, `0x04cd15...` и т.д. — это **Zigbee-устройства**. В MQTT они видны как `/devices/0x.../controls/...`. Если в списке топиков есть `/devices/0x...` — на контроллере есть Zigbee.

## Архитектура

В основе — **zigbee2mqtt** (отдельный проект, не привязан к релизам WB). Он общается с Zigbee-адаптером и публикует данные в свои топики `zigbee2mqtt/<friendly_name>`. Ставится пакетом `apt install zigbee2mqtt` или в Docker.

Поверх zigbee2mqtt работает один из двух **конвертеров** для трансляции в WB MQTT Conventions (`/devices/.../controls/...`):

- **wb-mqtt-zigbee** (новый, рекомендуемый, в testing-репозитории) — прямая трансляция, контролы работают в обе стороны, управление через веб-интерфейс без wb-rules. Устройства видны как `/devices/zigbee_*`.
- **wb-zigbee2mqtt** (старый) — создаёт виртуальные устройства через wb-rules. Контролы WB-конвенции `/devices/<friendly_name>/controls/<control>` — **readonly** (нельзя писать через `dev["name/control"] = value`). Для управления:
  ```js
  // wb-rules: управление zigbee-устройством через wb-zigbee2mqtt
  publish("zigbee2mqtt/friendly_name/set", JSON.stringify({ state: "OFF" }), 2, false);
  ```

## Аппаратный модуль

Zigbee-адаптер — модуль расширения **WBE2R-R-ZIGBEE** (v.2 актуальная). Конфигурируется в **wb-hardware.conf** (веб-UI: Настройки → Модули расширения и порты → выбрать слот → тип «WBE2R-R-ZIGBEE»). Порт зависит от слота: MOD1→`/dev/ttyMOD1`, MOD2→`/dev/ttyMOD2` и т.д. Этот порт прописывается в `serial.port` конфига zigbee2mqtt (`/mnt/data/root/zigbee2mqtt/data/configuration.yaml`).

Модуль **не отображается** на странице Устройства — это нормально.

Также поддерживаются USB-стики (порт `/dev/ttyUSBx`).

> **Установка zigbee2mqtt и конвертера** — см. скилл `software-install` (секция Zigbee2MQTT).

## Как найти устройства

**ОБЯЗАТЕЛЬНЫЙ порядок. Не пропускай шаги, не заменяй своими способами.**

**НЕ используй `mqtt_list_topics(prefix='zigbee2mqtt/#')` и `mqtt_list_topics(prefix='/devices/+/meta/name')` — первый вернёт мегабайты, второй найдёт ВСЕ устройства, а не zigbee.**

### Шаг 1 — найди контроллеры с zigbee2mqtt

По каждому онлайн-контроллеру (можно параллельно):
`mqtt_read(sn, "zigbee2mqtt/bridge/state")` — `"online"` = zigbee2mqtt работает.

Если пусто — проверь Docker: `ssh_exec(sn, "docker ps 2>/dev/null | grep -i zigbee")`. zigbee2mqtt часто работает в Docker и публикует в тот же MQTT-брокер.

**Результат шага 1** — список SN где есть zigbee2mqtt. Дальше работай только с ними.

### Шаг 2 — есть ли спаренные устройства?

Проверь наличие топика (без чтения содержимого — JSON огромный!):
`mqtt_list_topics(sn, prefix="zigbee2mqtt/bridge/devices")` — если топик есть, значит устройства спарены.

### Шаг 3 — детальный список (только если пользователь просит)

`mqtt_read(sn, "zigbee2mqtt/bridge/devices")` — полный JSON со всеми устройствами. Фильтруй `type != "Coordinator"` (это адаптер, не устройство).

Для wb-mqtt-zigbee (testing): `mqtt_list_topics(sn, prefix="/devices/zigbee_")`.

## Спаривание

Через веб-интерфейс контроллера: вкладка Devices → карточка Zigbee2mqtt → включить «Permit join» → зажать кнопку pair на устройстве → дождаться подтверждения → выключить Permit join.

Через MQTT: `mqtt_publish(sn, "zigbee2mqtt/bridge/request/permit_join", '{"value": true}')`.

## Грабли

- `mqtt_list_topics(prefix='zigbee2mqtt/#')` — мегабайты, не делай.
- `mqtt_read("zigbee2mqtt/bridge/devices")` — огромный JSON. Парси через `ssh_exec` + python3.
- `type: "Coordinator"` — это адаптер, не устройство. Фильтруй.
- zigbee2mqtt может быть в Docker — `ssh_exec(sn, "docker ps 2>/dev/null | grep -i zigbee")`.
- Наличие пакета ≠ наличие устройств.
- Модуль WBE2R-R-ZIGBEE не виден на странице Устройства — проверяй через wb-hardware.conf.

## Документация

- Zigbee на WB: <https://wiki.wirenboard.com/wiki/Zigbee>
- Модуль WBE2R-R-ZIGBEE v.2: <https://wiki.wirenboard.com/wiki/WBE2R-R-ZIGBEE_v.2_ZigBee_Extension_Module>
- wb-mqtt-zigbee: <https://github.com/wirenboard/wb-mqtt-zigbee>
