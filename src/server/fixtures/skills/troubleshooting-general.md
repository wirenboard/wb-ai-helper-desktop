# troubleshooting-general

Общая диагностика проблем на контроллере Wiren Board. Подгружай когда пользователь говорит: «не работает», «почини», «сломалось», «ошибка», «не запускается», «упал сервис», «проблема с…», «собери диагностику», «диагностический архив», «логи и состояние» — и это НЕ про serial/Modbus (для serial есть troubleshooting-serial).

Не путай с бэкапом (`controller-backup`). Диагностический архив — для анализа и поддержки, не для восстановления. Собирается утилитой `wb-diag-collect` и включает: конфиги из `/etc`, логи сервисов (wb*, mosquitto, NetworkManager и др.), вывод диагностических команд (df, ps, ip, dpkg и др.).

## Первые шаги — всегда

Прежде чем чинить — разберись в причине. Не чини симптомы.

### 0. Документация — ОБЯЗАТЕЛЬНО

**Перед любой починкой** вызови `web_fetch` на страницу проблемного компонента в вики WB. Например: Docker → `web_fetch('https://wiki.wirenboard.com/wiki/Docker')`, Modbus → `web_fetch('https://wiki.wirenboard.com/wiki/Modbus')`, Home Assistant → `web_fetch('https://wiki.wirenboard.com/wiki/Home_Assistant')`. Ищи разделы "Известные проблемы", "Troubleshooting", "Ограничения". Если решение там есть — применяй его, не изобретай своё.

### 1. Kernel mismatch

**Самая частая причина проблем после обновления.** Проверь первым делом:

```bash
echo "running: $(uname -r)"; dpkg -l 'linux-image-wb*' 2>/dev/null | grep ^ii | awk '{print "installed:", $3}'
```

Если версии не совпадают — контроллер работает на старом ядре. Модули ядра (br_netfilter, iptable_nat, can, i2c и др.) не загрузятся, Docker/iptables/сеть могут не работать. **Единственное решение — перезагрузка.** Не пытайся обойти через modprobe/iptables-legacy — это бесполезно при kernel mismatch.

### 2. Место на диске

```bash
df -h / /mnt/data
```

Rootfs < 100 МБ — критично: apt не работает, логи не пишутся, сервисы падают. Чистка: `apt clean; journalctl --vacuum-time=3d; rm -rf /tmp/*`.

### 3. Упавшие сервисы

```bash
systemctl --failed --no-pager
```

Для каждого упавшего: `journalctl -u <unit> -n 50 --no-pager` — причина в логах.

### 4. Журнал ошибок

```bash
journalctl -p err -n 50 --no-pager
```

### 5. Нагрузка и память

```bash
uptime; free -h
```

Load > 4 на WB — перегрузка. `top -bn1 | head -20` покажет кто ест CPU.

## Типичные проблемы

| Симптом | Первый шаг |
|---|---|
| Сервис не запускается после обновления | Kernel mismatch → перезагрузка |
| Docker не стартует, iptables ошибки | Сначала kernel mismatch. Если ядро ОК — iptables-legacy fix (см. ниже) |
| modprobe: module not found | Kernel mismatch → перезагрузка |
| apt не работает, dpkg lock | `fuser /var/lib/dpkg/lock-frontend` — кто держит. Если зомби от прерванного apt: `dpkg --configure -a` |
| Сервис падает в цикле | `journalctl -u <unit> -n 100` — ищи причину, не перезапускай вслепую |
| Нет сети | `ip addr`, `nmcli`, `ping 8.8.8.8`, `cat /etc/resolv.conf` |
| MQTT не работает | `systemctl is-active mosquitto`, `mosquitto_sub -t '#' -C 1 -W 2` |
| Web UI не открывается | `systemctl is-active nginx wb-mqtt-homeui` |

## Docker и iptables

Если Docker не стартует с ошибками вроде `Chain 'MASQUERADE' does not exist`, `DOCKER-ISOLATION-STAGE`, `Failed to Setup IP tables` — и kernel mismatch исключён:

1. Переключи iptables на legacy:
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

Если не помогло — перезагрузка: `ssh_exec(sn, "reboot")`. Подробнее: <https://wiki.wirenboard.com/wiki/Docker>.

## Диагностический архив

**Собирай ТОЛЬКО в двух случаях:**
1. Пользователь явно просит «пришли диагархив» / «диагностический архив»
2. Составляешь багрепорт — архив обязателен как вложение вместе с логами по проблеме

Во всех остальных случаях (диагностика, поиск причины, починка) — **не создавай архив**, работай с логами напрямую через `ssh_exec`.

```
ssh_exec_async(sn, "wb-diag-collect /tmp/diag", label="сбор диагностики")
```

`wb-diag-collect` берёт аргумент как **префикс** и сам дописывает `_SN_ДАТА.zip` — реальное имя заранее неизвестно. Сбор занимает 30-60 секунд.

После завершения — найди файл и скачай:
```
ssh_exec(sn, "ls /tmp/diag*.zip | tail -1")
fetch_from_controller(sn, "<путь из вывода ls>")
```

## Принцип

Диагностируй → читай документацию → объясни причину → предложи решение → жди подтверждения. Не чини вслепую.
