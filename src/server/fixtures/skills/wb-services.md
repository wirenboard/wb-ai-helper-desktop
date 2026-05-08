# wb-services

systemd-сервисы и таймеры на контроллере Wiren Board: управление существующими unit'ами, override-конфиги для пакетных, создание своих сервисов и таймеров. Подгружай на: «сделай сервис из скрипта», «таймер на бэкап», «override на ExecStart», «после apt upgrade override пропал», «таймер не срабатывает», «как запустить X на загрузке», «mask/unmask юнит».

**Граница:** упавшие сервисы / диагностика — `troubleshooting-general`. Обновление пакетов — `controller-update`.

## Базовые команды

Используй tool `systemd_unit` (`action: status/start/stop/restart/reload/enable/disable/mask/unmask/cat/list-deps`) — он одним вызовом возвращает структурированный объект `{active, sub, load, unitFileState, exitCode, mainPid, since, statusTail}`. Для read-only-проверок (status/cat/list-deps) подтверждение не нужно. Для start/stop/restart/enable/disable/mask/unmask — HITL.

Если нужен журнал — `wb_logs` или `ssh_exec("journalctl -u <unit> -n 50 --no-pager")`. Полный список упавших — `failed_units`.

`systemctl status <unit>` для упавшего юнита возвращает exit 3 — это **код состояния, не ошибка ssh**.

## Override-конфиг (drop-in) — правильный способ менять пакетный юнит

Никогда не редактируй `/lib/systemd/system/<unit>.service` напрямую — apt перезапишет на upgrade. Используй drop-in:

```bash
ssh root@<HOST> 'mkdir -p /etc/systemd/system/<unit>.service.d'
ssh root@<HOST> 'cat > /etc/systemd/system/<unit>.service.d/override.conf' <<'EOF'
[Service]
Restart=on-failure
RestartSec=10s
EOF
ssh root@<HOST> 'systemctl daemon-reload && systemctl restart <unit>'
```

**Чтобы стереть директиву из основного файла, переобъяви её пустой:**

```ini
[Service]
ExecStart=
ExecStart=/usr/local/bin/my-wrapped-service
```

Без сброса первой пустой строкой systemd добавит вторую к первой, а не заменит. После — `daemon-reload`, `restart`, проверь `systemctl cat <unit>` (виден ли drop-in) и `systemctl show <unit> -p ExecStart`.

### Пример: fix `fstrim.service` со `status=64/USAGE`

Типичный кейс — `/etc/fstab` ссылается на `/mnt/sdcard` без вставленной SD-карты, fstrim падает.

```bash
ssh root@<HOST> 'mkdir -p /etc/systemd/system/fstrim.service.d'
ssh root@<HOST> 'cat > /etc/systemd/system/fstrim.service.d/override.conf' <<'EOF'
[Service]
ExecStart=
ExecStart=/sbin/fstrim --fstab --quiet-unsupported
EOF
ssh root@<HOST> 'systemctl daemon-reload && systemctl reset-failed fstrim.service'
```

`--quiet-unsupported` пропускает физически отсутствующие точки монтирования.

## Свой сервис из скрипта

1. **Скрипт** в `/usr/local/bin/<name>.sh`, owner root, `chmod 0755`.
2. **Юнит** в `/etc/systemd/system/<name>.service`:

```ini
[Unit]
Description=My periodic task
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/bin/my-task.sh
StandardOutput=journal
StandardError=journal
```

`Type=oneshot` — для одноразовых задач (типичный кейс — под таймером). Для долгоживущих сервисов — `Type=simple` (default) или `Type=notify` (если бинарь умеет sd_notify).

3. После создания — `systemctl daemon-reload`, потом проверь `systemctl start my-task && systemctl status my-task`.

## Таймер

Таймер — отдельный юнит `<name>.timer`, который запускает одноимённый `<name>.service`:

```ini
[Unit]
Description=Run my-task every hour

[Timer]
OnCalendar=hourly
Persistent=true
RandomizedDelaySec=2min

[Install]
WantedBy=timers.target
```

После — `systemctl daemon-reload && systemctl enable --now my-task.timer`.

- **`OnCalendar=hourly`** — раз в час. Полный синтаксис: `OnCalendar=*-*-* 03:00:00` (ежедневно 03:00), `Mon..Fri 08:00`, `*-*-1 12:00` (1-е число в 12:00). Проверка выражения: `systemd-analyze calendar 'Mon..Fri 08:00'`.
- **`Persistent=true`** — если контроллер был выключен в момент срабатывания, таймер сработает сразу при загрузке.
- **`RandomizedDelaySec`** — рандомизирует старт (полезно когда несколько контроллеров стучатся в один сервер).

Альтернативы: `OnBootSec=2min` (через X после загрузки) / `OnUnitActiveSec=10min` (каждые X после предыдущего).

Список таймеров и следующее срабатывание — `systemctl list-timers --no-pager`.

## wb-rules cron vs systemd timer

| Кейс | Что выбрать |
|---|---|
| Условие зависит от MQTT-state, dev[], таймеров и других правил | wb-rules `cron(...)` или `setInterval` (см. `wb-rules`) |
| Простая shell-команда по расписанию | systemd timer (этот скилл) |
| Бэкап, синхронизация, мониторинг — задача не привязана к шине | systemd timer |
| Нужно запустить задачу при загрузке + потом ежедневно | systemd timer (`OnBootSec=` + `OnCalendar=`) |
| Реакция на изменение control'а / событие шины | wb-rules `whenChanged` (cron не нужен) |

## Enable / disable / mask

- `enable` — добавить в автозапуск; `--now` дополнительно стартует сразу.
- `disable` — убрать из автозапуска (юнит остаётся, можно стартовать вручную).
- `mask` — запретить запуск (даже по зависимостям) — symlink в `/dev/null`. Сильнее `disable`. Используй для отключения пакетного сервиса который другие сервисы могли бы стартовать (например `bluetooth.service` на headless-контроллерах).
- `unmask` — отменить mask.
- `reset-failed <unit>` — очистить failed-статус без рестарта.

## После apt upgrade

Override и custom-юниты в `/etc/systemd/system/` **переживают** apt upgrade — пакет может изменить `/lib/systemd/system/<unit>.service`, но drop-in остаётся в действии. Если после upgrade пакетный юнит не подхватил override — `systemctl daemon-reload && systemctl restart <unit>`.

**Custom-юниты в `/etc/systemd/system/` НЕ переживают FIT-прошивку** (она перезаписывает rootfs). Для бэкапа — `controller-backup`, секция «Custom systemd units».

## Грабли

- **Прямая правка `/lib/systemd/system/<unit>.service`** — apt переписывает. Только drop-ins.
- **`ExecStart=` в drop-in без сброса** — добавляет вторую команду к первой. Сначала пустой `ExecStart=`, потом новый.
- **Забыли `daemon-reload`** — systemd не видит изменений. После любой правки .service/.timer.
- **`enable` без `--now`** — юнит включён, но не стартанул в этой сессии. `enable --now` или отдельный `start`.
- **`OnCalendar` некорректный** — проверь через `systemd-analyze calendar '<expr>'` ДО деплоя.
- **`Type=oneshot` без `RemainAfterExit=yes`** — после успешного выполнения юнит «inactive (dead)», не active. Для таймера это норма; если ждёшь active — добавь `RemainAfterExit=yes`.
- **Custom-юнит без секции `[Install]`** — `enable` упадёт с «No installation information found».
- **`mask` без последующего `unmask`** — забытый mask ломает сервисы на следующем апгрейде.

## Документация

- systemd unit: https://www.freedesktop.org/software/systemd/man/systemd.unit.html
- systemd timer: https://www.freedesktop.org/software/systemd/man/systemd.timer.html
- OnCalendar формат: https://www.freedesktop.org/software/systemd/man/systemd.time.html
