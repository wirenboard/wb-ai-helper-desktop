# software-install

Установка стороннего и дополнительного ПО на контроллер Wiren Board. Подгружай когда пользователь просит установить, настроить или интегрировать: Docker, Node-RED, Home Assistant, Zigbee2MQTT, Mosquitto, InfluxDB, Grafana, Telegram-бот, или любой другой сторонний софт. Также если спрашивает про интеграцию с внешними системами или подключение устройств.

## Перед установкой

1. **Проверь документацию.** Многие популярные пакеты имеют специфику установки на WB. Сначала `web_fetch` по вики:
   - Docker: `web_fetch('https://wiki.wirenboard.com/wiki/Docker')`
   - Home Assistant: `web_fetch('https://wiki.wirenboard.com/wiki/Home_Assistant')`
   - Совместимый софт и устройства: `web_fetch('https://wiki.wirenboard.com/wiki/Supported_devices')`
   - Общий поиск: `web_fetch('https://wirenboard.com/wiki/Special:Search?search=<запрос>')`
2. **Проверь место** — `df -h / /mnt/data`. Rootfs на WB всего 2 ГБ, данные складывай в `/mnt/data`.
3. **Проверь что уже установлено** — `dpkg -l | grep <пакет>`, `systemctl is-active <сервис>`.
4. **Сделай слепок** — `save_state_for_diff(sn)` перед установкой. После установки — `diff_snapshot(sn, path)` чтобы показать что изменилось (новые пакеты, сервисы, файлы).

## Специфика WB

### Docker

**НЕ ставь через `apt install docker.io` или `apt install docker-ce` напрямую** — rootfs (2 ГБ) переполнится. ЕДИНСТВЕННЫЙ правильный способ — скрипт `wb-docker-manager.sh`:

```bash
ssh_exec_async(sn, "wget -O /tmp/wb-docker-manager.sh https://raw.githubusercontent.com/wirenboard/wb-community/refs/heads/main/scripts/docker-install/wb-docker-manager.sh && bash /tmp/wb-docker-manager.sh --install", label="install docker")
```

**Что делает скрипт (НЕ повторяй вручную — просто запусти скрипт выше):**
1. Ставит зависимости: `ca-certificates curl gnupg lsb-release iptables`
2. Добавляет официальный Docker-репозиторий (GPG-ключ + sources.list) — пакет `docker-ce`, НЕ `docker.io`
3. Переключает iptables на legacy-версию (нужно для Docker на WB)
4. Создаёт директории и симлинки для хранения данных на `/mnt/data/`:
   - `/mnt/data/etc/docker` → `/etc/docker` (конфиг)
   - `/mnt/data/var/lib/containerd` → `/var/lib/containerd`
   - `/mnt/data/.docker` — хранилище образов (`data-root` в daemon.json)
5. Настраивает лимит логов: 10 МБ × 3 файла
6. Ставит `docker-ce docker-ce-cli containerd.io`
7. Включает автозапуск и проверяет `hello-world`

**После установки проверь:**
```
ssh_exec(sn, "docker --version && docker info --format '{{.DockerRootDir}}' && df -h /mnt/data")
```
Docker root должен быть `/mnt/data/.docker`. Ожидаемое содержимое `/etc/docker/daemon.json`:
```json
{
  "data-root": "/mnt/data/.docker",
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" }
}
```

Docker Compose файлы обычно кладут в `/mnt/data/<проект>/`.

Документация: <https://wiki.wirenboard.com/wiki/Docker>.

### Home Assistant

Ставится через Docker. Инструкция: <https://wiki.wirenboard.com/wiki/Home_Assistant>.

### Zigbee2MQTT

Полный флоу установки:

1. **Проверь аппаратный модуль** — загрузи конфигурацию модулей:
```
get_hardware_config(sn=SN)
```
Ищи в `content` слоты `mod1`–`mod4` с `module` содержащим `zigbee`.

   - **Модуль найден** → запомни номер слота и порт (например `mod3` → **ZIGBEE_PORT=`/dev/ttyMOD3`**). Переходи к шагу 2.
   - **Модуль НЕ найден** → спроси пользователя: «В какой слот (MOD1–MOD4) установлен Zigbee-модуль WBE2R-R-ZIGBEE?» или «Модуль ещё не установлен?». Если пользователь указал слот — настрой модуль:
```
// В content найди нужный слот по id (например "mod3") и установи module:
// slot.module = "wbe2-i-zigbee"  (точное значение бери из schema.oneOf!)
save_hardware_config(sn=SN, content=<изменённый content>)
```
После сохранения проверь что порт появился: `ssh_exec(sn, "ls -la /dev/ttyMOD<N>")`.
Запомни порт: **ZIGBEE_PORT=`/dev/ttyMOD<N>`** (где N — номер слота).
Если USB-стик — **ZIGBEE_PORT=`/dev/ttyUSBx`**, настройка wb-hardware.conf не нужна.

> Подробнее о настройке модулей — скилл `hardware-modules`.

2. **Проверь наличие wb-mqtt-zigbee** (рекомендуемый конвертер для интеграции с UI):
```bash
ssh_exec(sn, "apt-cache show wb-mqtt-zigbee 2>/dev/null | head -5")
```

3. **Установи zigbee2mqtt**:
   - Если wb-mqtt-zigbee доступен — ставь **без Recommends** (иначе потянет старый wb-zigbee2mqtt):
```bash
ssh_exec_async(sn, "apt-get update && apt-get -y --no-install-recommends install zigbee2mqtt && apt-get -y install wb-mqtt-zigbee", label="install zigbee2mqtt")
```
   - Если wb-mqtt-zigbee недоступен — ставь обычно (подтянет wb-zigbee2mqtt как Recommends):
```bash
ssh_exec_async(sn, "apt-get update && apt-get -y install zigbee2mqtt", label="install zigbee2mqtt")
```

4. **Настрой порт zigbee2mqtt** — пропиши **ZIGBEE_PORT** (определён на шаге 1) в `serial.port` конфига:
```bash
ssh_exec(sn, "sed -i 's|port:.*|port: /dev/ttyMOD<N>|' /mnt/data/root/zigbee2mqtt/data/configuration.yaml")
```
Подставь фактический порт из шага 1 вместо `/dev/ttyMOD<N>`.

5. **Запусти и включи автозапуск**:
```bash
ssh_exec(sn, "systemctl enable --now zigbee2mqtt && systemctl is-active zigbee2mqtt")
```

6. **Проверь**:
```bash
ssh_exec(sn, "systemctl is-active zigbee2mqtt && mosquitto_sub -t 'zigbee2mqtt/bridge/state' -C 1 -W 5")
```

> **Поиск и управление устройствами** — см. скилл `zigbee`.

Документация: <https://wiki.wirenboard.com/wiki/Zigbee>, <https://wiki.wirenboard.com/wiki/WBE2R-R-ZIGBEE_v.2_ZigBee_Extension_Module>.

### Node-RED

Ставится через Docker. Данные в `/mnt/data/node-red/`.

## Общие правила

- Установка пакетов — через `ssh_exec_async` (долгая операция): `apt-get -y install <пакет>`. Сервер добавит `DEBIAN_FRONTEND=noninteractive` автоматически.
- Данные стороннего ПО — всегда в `/mnt/data/`, не в rootfs. Создавай симлинки если сервис хочет писать в `/var/lib/`.
- После установки проверь: `systemctl is-active <сервис>`, `journalctl -u <сервис> -n 20`.
- Если пользователь спрашивает про интеграцию незнакомого устройства — сначала `web_fetch('https://wiki.wirenboard.com/wiki/Supported_devices')` и поищи там.

## Если Docker не запускается после установки

**Первым делом проверь kernel mismatch:** `uname -r` vs `dpkg -l linux-image-wb*`. Если версии не совпадают — контроллер работает на старом ядре после обновления. Модули ядра (br_netfilter, iptable_nat и др.) не загрузятся, Docker/iptables не заработают. Решение — перезагрузка, не обходные пути.

**Ошибка iptables / MASQUERADE / DOCKER-ISOLATION-STAGE.** Если в `journalctl -u docker` видишь:
```
error creating default "bridge" network: Failed to Setup IP tables: Unable to enable NAT rule:
Chain 'MASQUERADE' does not exist
```
или подобные ошибки про iptables/nf_tables — это значит Docker не может настроить виртуальные сети. Решение из вики:

1. Переключи iptables на legacy-версию (скрипт `wb-docker-manager.sh` делает это сам, но если ставили вручную — могли пропустить):
```bash
ssh_exec(sn, "update-alternatives --set iptables /usr/sbin/iptables-legacy && update-alternatives --set ip6tables /usr/sbin/ip6tables-legacy")
```

2. Создай недостающее правило NAT:
```bash
ssh_exec(sn, "iptables -w10 -t nat -I POSTROUTING -s 172.17.0.0/16 ! -o docker0 -j MASQUERADE")
```

3. Перезапусти Docker:
```bash
ssh_exec(sn, "systemctl restart docker && systemctl is-active docker")
```

Если и после этого не работает — перезагрузка: `ssh_exec(sn, "reboot")`.

## Грабли

- `apt install docker-ce` без `wb-docker-manager.sh` — rootfs заполнится, контроллер ляжет.
- Забыть перенести данные в `/mnt/data/` — при FIT-обновлении всё потеряется.
- Ставить тяжёлые пакеты через `ssh_exec` — таймаут, процесс останется висеть.
- При kernel mismatch (`uname -r` ≠ `dpkg -l linux-image-wb*`) модули ядра не загрузятся — нужна перезагрузка. Но переключение на iptables-legacy нужно в любом случае для Docker на WB.

## Документация

- Docker: <https://wiki.wirenboard.com/wiki/Docker>
- Home Assistant: <https://wiki.wirenboard.com/wiki/Home_Assistant>
- Поддерживаемые устройства: <https://wiki.wirenboard.com/wiki/Supported_devices>
- Community-скрипты: <https://github.com/wirenboard/wb-community>
