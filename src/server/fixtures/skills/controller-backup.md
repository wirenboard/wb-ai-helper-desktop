# controller-backup

Бэкап и восстановление контроллера WB — собрать архив с конфигами, данными и списками пакетов; отдать пользователю; восстановить после прошивки или на новом контроллере. Подгружай на «сделай бэкап», «бэкап контроллера», «сохрани контроллер», «пришли мне бэкап», «бэкап перед обновлением», «откатить после прошивки», «восстановить из бэкапа», «перенести настройки».

**Это НЕ диагностический архив.** Если пользователь просит «диагностический архив», «логи для поддержки», «wb-diag-collect» — это скилл `diagnostic-archive`, не бэкап. Бэкап — полный процесс восстановления контроллера (пакеты, конфиги, данные, RESTORE.md), занимает минуты.

**НА КОНТРОЛЛЕРЕ НЕТ УТИЛИТЫ БЭКАПА.** Не существует `wb-backup`, `wbctl backup`, `backup.sh` — не выдумывай. Бэкап собирается в 3 фазы ниже.

**Бэкап = tar.gz архив** с файлами, конфигами, списками пакетов. `save_state_for_diff` — НЕ бэкап, а слепок для верификации. Продолжай к фазе 2.

**Все файлы — в `/mnt/data/ai/wb-cloud-assistant/backups/`.** Не раскидывай по `/tmp`, `/root`, `/mnt/data/backups`. Переменная `$B` ниже уже указывает на правильный каталог.

## Чеклист — выводи после каждого шага

**БЭКАП НЕ ГОТОВ**, пока не пройдены ВСЕ шаги. После завершения каждого шага (включая получение результата фоновой задачи) выведи чеклист и **немедленно переходи к следующему незавершённому шагу**. Не останавливайся, не спрашивай пользователя (кроме подтверждения в фазе 1).

```
Прогресс бэкапа:
[✓] Фаза 1: аудит и отчёт
[✓] Фаза 1: подтверждение пользователя
[⏳] Фаза 2.1: core-архив (метаданные + конфиги)
[ ] Фаза 2.2: audit-files (кастомные файлы по аудиту)
[ ] Фаза 2.3: Docker volumes (если есть)
[ ] Фаза 3.1: RESTORE.md
[ ] Фаза 3.2: финальная упаковка
[ ] Фаза 3.3: доставка пользователю
```

Пропускай шаги которые не нужны (напр. Docker volumes если нет Docker), но помечай их `[—]`. Шаг с `[⏳]` — текущий. **Не выводи «бэкап готов» пока все шаги не `[✓]` или `[—]`.**

## Фаза 1 — аудит и решение (первый ответ модели)

### Шаг 1: собери данные

Выполни оба вызова:
1. `audit_controller(sn)` — что кастомное на контроллере
2. `save_state_for_diff(sn)` — слепок для верификации после восстановления

### Шаг 2: покажи отчёт

Покажи пользователю **краткий отчёт** по находкам аудита (не сырой JSON):
- Доустановленные пакеты (`extraPackages`)
- Включённые сервисы сверх стока (`extraEnabledServices`)
- Кастомные файлы и скрипты (`customFiles`, `customSystemdUnits`)
- Изменённые конфиги (`modifiedConfigs`)
- Пользовательские каталоги в `/mnt/data/` (`mntdataUserDirs`) — с размерами

### Шаг 3: составь список путей для бэкапа

По результатам аудита собери **полный список путей**, которые нужно сохранить. Источники:

| Поле аудита | Что с ним делать |
|---|---|
| `customFiles` (`/opt/`, `/usr/local/bin/`, `/usr/local/sbin/`) | Добавить каждый путь в список |
| `customSystemdUnits` | Добавить файлы юнитов. Прочитать `ExecStart=` — если скрипт не из пакета, добавить и его |
| `modifiedConfigs` | Добавить каждый изменённый конфиг |
| `mntdataUserDirs` | Это **пользовательские проекты** (не Docker-хранилище!). Добавить каждый каталог, показать размер. Даже если в названии есть «docker» (напр. `picoclow-docker`) — это проект с compose-файлами и данными, его НАДО бэкапить |
| `extraPackages` не из таблицы ниже | `ssh_exec(sn, "dpkg -L <pkg> \| grep -E '^/(etc\|var/lib\|opt\|srv)'")` — добавить найденные пути |
| `extraEnabledServices` | Не архивировать — запишется в `services-enabled.list` автоматически |

Раздели результат на **безопасное** и **крупное**:
- **Безопасное** (файлы, конфиги, мелкие каталоги) — включить без вопросов
- **Крупное** (каталоги > 10 МБ из `mntdataUserDirs`, named Docker volumes, БД) — показать размер, спросить

Покажи пользователю сводку: что войдёт в бэкап, что крупное, что опасное (БД, Docker).

**СТОП. Жди подтверждение пользователя. Не запускай tar без подтверждения.**

## Фаза 2 — сборка архива (после подтверждения)

**Все шаги складывают файлы в один каталог `$B`.** В фазе 3 весь каталог пакуется в единый архив — объединять вручную не нужно.

### Шаг 1: метаданные и core-конфиги

Запускай ЭТОТ скрипт через `ssh_exec_async`. Не придумывай свой скрипт для этой части.

```
ssh_exec_async(sn, "set -e; TS=$(date +%Y%m%d-%H%M%S); B=/mnt/data/ai/wb-cloud-assistant/backups/$TS; mkdir -p $B; cat /etc/wb-fw-version > $B/fw-version 2>/dev/null || true; cp /usr/lib/wb-release $B/wb-release 2>/dev/null || true; apt-mark showmanual > $B/packages-manual.list; dpkg-query -W -f='${Package}=${Version}\n' > $B/packages-all.list; systemctl list-unit-files --state=enabled --no-legend | awk '{print $1}' > $B/services-enabled.list; find /etc -maxdepth 3 -type l -exec sh -c 'T=$(readlink -f \"$1\"); case \"$T\" in /mnt/data/*) echo \"$1 -> $T\";; esac' _ {} \\; > $B/symlinks-etc.list; tar czf $B/core.tar.gz -C / --warning=no-file-changed --ignore-failed-read mnt/data/etc etc/wb-rules etc/wb-mqtt-serial.conf etc/wb-mqtt-serial.conf.d etc/network etc/hostname etc/resolv.conf etc/ntp.conf etc/chrony 2>/dev/null || true; find / /mnt/data -xdev \\( -path /mnt/data/.docker -o -path /mnt/data/var/lib/containerd \\) -prune -o \\( -name 'docker-compose.y*ml' -o -name 'compose.y*ml' \\) -print 2>/dev/null | tar czf $B/compose-files.tar.gz -T - 2>/dev/null || true; SNAP=$(ls -t /mnt/data/ai/wb-cloud-assistant/snapshots/snapshot-*.json 2>/dev/null | head -1); [ -n \"$SNAP\" ] && cp \"$SNAP\" $B/state-snapshot.json; echo BACKUP_DIR=$B; du -sh $B $B/*", label="backup controller")
```

Из вывода джобы возьми путь `BACKUP_DIR=...` — например `/mnt/data/ai/wb-cloud-assistant/backups/20260419-224500`. **Подставляй этот конкретный путь во все последующие шаги.** Не пиши `$B` в следующих `ssh_exec_async` — переменная не сохраняется между вызовами!

### Шаг 2: данные по результатам аудита

```
ssh_exec_async(sn, "tar czf /mnt/data/ai/wb-cloud-assistant/backups/<ts>/audit-files.tar.gz --warning=no-file-changed --ignore-failed-read <пути из аудита> 2>/dev/null || true; du -sh /mnt/data/ai/wb-cloud-assistant/backups/<ts>/audit-files.tar.gz", label="backup audit files")
```

Подставляй **конкретные пути** из шага 3 фазы 1:
- `customFiles`: `/opt/my-app/`, `/usr/local/bin/my-script.sh`
- `customSystemdUnits`: `/etc/systemd/system/my-service.service`
- `modifiedConfigs`: `/etc/mosquitto/mosquitto.conf`
- `mntdataUserDirs`: `/mnt/data/picoclow-docker/` — это пользовательские проекты, бэкапить!
- Конфиги `extraPackages`: пути из `dpkg -L`
- Конфиги известных пакетов (таблица ниже): `/mnt/data/root/zigbee2mqtt`, `/etc/mosquitto`, `/etc/nginx`, `/etc/grafana`, `/var/lib/grafana/grafana.db`, `/etc/influxdb`, `/root/.node-red/flows*.json`, `/root/.node-red/settings.js`, `/mnt/data/etc/docker`, `/etc/cron.d`

### Шаг 3: named Docker volumes (если есть Docker)

Если в `extraPackages` есть `docker-ce`:
```
ssh_exec(sn, "docker volume ls -q 2>/dev/null")
```
Если есть volumes с данными:
```
ssh_exec_async(sn, "B=/mnt/data/ai/wb-cloud-assistant/backups/<ts>; for v in $(docker volume ls -q); do docker run --rm -v $v:/data alpine tar czf - /data > $B/docker-volume-$v.tar.gz 2>/dev/null; done; ls -lh $B/docker-volume-*.tar.gz 2>/dev/null", label="backup docker volumes")
```

## Фаза 3 — доставка (после завершения ВСЕХ джоб)

Дождись завершения всех шагов фазы 2 (core + audit-files + docker volumes если были).

### 1. RESTORE.md

Сгенерируй и запиши инструкцию восстановления:
```
write_file(sn, '/mnt/data/ai/wb-cloud-assistant/backups/<ts>/RESTORE.md', '...')
```
Содержимое — по фактическим данным аудита. **Обязательные** секции (не пропускай ни одну):

1. **Пакеты** — перечисли ВСЕ `extraPackages` из аудита. Для Docker — через `wb-docker-manager.sh` (см. скилл `software-install`). Для остальных — `apt install <pkg1> <pkg2> ...`. Порядок: сначала зависимости, потом зависимые. **Эта секция критична** — без пакетов конфиги бесполезны.
2. **Файлы** — что распаковать и куда (`tar xzf core.tar.gz -C /`, `tar xzf audit-files.tar.gz -C /`)
3. **Симлинки** — какие восстановить (из `symlinks-etc.list`)
4. **Сервисы** — какие включить (`systemctl enable ...`) — по списку `extraEnabledServices` из аудита
5. **Ручные шаги** — что нельзя автоматизировать (Docker-образы: `docker compose pull`, БД, node_modules)
6. **Верификация** — `diff_snapshot(sn, "path/to/state-snapshot.json")`

Пиши конкретные пути, имена пакетов и команды — не `$переменные` и не `<placeholder>`.

### 2. Собери в один файл

```
ssh_exec_async(sn, "cd /mnt/data/ai/wb-cloud-assistant/backups && tar czf backup-<ts>.tar.gz <ts>/ && du -sh backup-<ts>.tar.gz", label="pack backup")
```

### 3. Проверь размер и отдай

```
ssh_exec(sn, "stat -c%s /mnt/data/ai/wb-cloud-assistant/backups/backup-<ts>.tar.gz")
```
- < 200 МБ → `fetch_from_controller(sn, '/mnt/data/ai/wb-cloud-assistant/backups/backup-<ts>.tar.gz')`
- > 200 МБ → предложи `scp` (пользователь выполняет сам)

### 4. Итоговый отчёт

- Какие доп. пакеты нужно установить при восстановлении (из `extraPackages` аудита) — перечисли конкретные имена
- Что сохранено (конкретные пути)
- Что НЕ сохранено — предупреди:
  - `/mnt/data/.docker/` (внутреннее хранилище Docker daemon: образы, слои) — восстанавливаются через `docker pull` / `docker compose pull`
  - Большие БД (InfluxDB) — `influxd backup` вручную
  - Node-RED `node_modules` — восстановится через `npm install`

## Docker: что бэкапить, что нет

**НЕ путай пользовательские проекты с Docker-хранилищем!**

| Что | Где | Бэкапить? | Как |
|---|---|---|---|
| compose-файлы | в проектах (`/mnt/data/<проект>/`) | ДА | tar как есть |
| bind-mount данные | в проектах | ДА | tar как есть |
| named volumes | `docker volume ls` | ДА, если есть данные | `docker run --rm -v vol:/d alpine tar czf - /d > vol.tar.gz` |
| Docker daemon (`/mnt/data/.docker/`) | внутреннее хранилище | НЕТ | образы через `docker pull`, восстановятся из compose |
| Конфиг демона | `/mnt/data/etc/docker/` | ДА | уже в core-архиве |

Пример: `/mnt/data/picoclow-docker/` (82 МБ) — это **проект пользователя** с compose, конфигами и данными. Его НАДО бэкапить целиком. А `/mnt/data/.docker/` — это слои образов, их бэкапить бессмысленно.

## Известные пакеты — что в архиве, что предупредить

| Пакет | Что в архиве | Что предупредить |
|---|---|---|
| `docker-ce` | `/mnt/data/etc/docker/`, compose-файлы, проекты из `mntdataUserDirs` | `/mnt/data/.docker/` НЕ в архиве. Docker ставится через `wb-docker-manager.sh` (см. `software-install`). Named volumes — отдельно |
| `zigbee2mqtt` | `/mnt/data/root/zigbee2mqtt/` | — |
| `nodered` | `flows*.json`, `settings.js` | `node_modules` восстановится через `npm install` |
| `mosquitto` | `/etc/mosquitto/` | — |
| `influxdb` | `/etc/influxdb/` | БД через `influxd backup`, не tar |
| `grafana` | `/var/lib/grafana/grafana.db`, `/etc/grafana/` | — |
| `nginx` | `/etc/nginx/` | Сертификаты `/etc/letsencrypt/` — отдельно |

## Что переживает FIT, что нет

FIT перезаписывает rootfs, НЕ трогает `/mnt/data/`.

| Переживает | Стирается |
|---|---|
| `/mnt/data/` целиком | `/usr/local/bin/`, `/opt/`, `/srv/` |
| Конфиги с симлинком в `/mnt/data/etc/` | `/etc/cron.d/<кастом>`, `/etc/systemd/system/<кастом>` |
| Сеть/время из веб-интерфейса | apt-пакеты вне стока |

## Восстановление

1. Найди бэкап: `ssh_exec(sn, "ls -lt /mnt/data/ai/wb-cloud-assistant/backups/")` (переживает FIT). Или пользователь загружает через чат → `upload_to_controller`.
2. Читай RESTORE.md: `read_file(sn, '/mnt/data/ai/wb-cloud-assistant/backups/<ts>/RESTORE.md')`.
3. Выполняй по шагам с подтверждением пользователя. Пакеты — через `ssh_exec_async`.
4. Верификация: `diff_snapshot(sn, "/mnt/data/ai/wb-cloud-assistant/backups/<ts>/state-snapshot.json")`.

## Грабли

- Выдумывать `wb-backup`, `wbctl backup`, `backup.sh` — их не существует.
- Core-скрипт менять нельзя. А вот audit-tar (шаг 2 фазы 2) — обязательно строй по данным аудита, не пропускай находки.
- Остановиться на `save_state_for_diff` — это НЕ бэкап. Продолжай к фазе 2.
- Запускать tar в `ssh_exec` — таймаут. Только `ssh_exec_async`.
- Бэкапить `/etc` или `/mnt/data` целиком — огромно и бесполезно.
- Молчать про `/mnt/data/.docker/` — предупреди что не в архиве.
- Лить сырой JSON аудита — покажи отчёт по категориям.
- Раскидывать файлы по `/tmp`, `/root`, `/mnt/data/backups` — всё в `/mnt/data/ai/wb-cloud-assistant/backups/`.
- Пропустить `modifiedConfigs` или `customSystemdUnits` — они тоже нужны в архиве.

## Документация

- FIT-update: <https://wirenboard.com/wiki/Wirenboard_Firmware_Update>
- Раздел data: <https://wirenboard.com/wiki/Data_Partition>
