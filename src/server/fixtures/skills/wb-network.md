# wb-network

Сетевая подсистема контроллера Wiren Board: **NetworkManager** управляет физическими соединениями (eth0/eth1/wlan0/ppp0/...), **wb-connection-manager** расставляет приоритеты между ними и делает автоматический failover. Конфиг `/etc/wb-connection-manager.conf` (через `confed`) — единый источник правды для веб-UI.

Подгружай на: «настрой 4G», «дай интернет через sim1», «WiFi-точка доступа», «нет внешнего ping», «статический IP», «настрой DNS», «eth1 не подключается», «модем не коннектится», «не работает failover», «OpenVPN-клиент», «параметры сети».

**Граница:** общая «что-то сломалось» диагностика — `troubleshooting-general`. Этот скилл — для целевой настройки.

## Архитектура

```
┌─────────────────────────────────────────────────┐
│  /etc/wb-connection-manager.conf  (confed UI)   │
│  └─ data:    физические интерфейсы              │
│  └─ ui:      приоритеты, типы, видно в WebUI    │
└────────────────────┬────────────────────────────┘
                     │ wb-connection-manager
                     ▼
┌─────────────────────────────────────────────────┐
│  NetworkManager (nmcli)                         │
│  └─ /etc/NetworkManager/system-connections/*.nmconnection │
│  └─ управляет ip / route / dns                  │
└─────────────────────────────────────────────────┘
```

`wb-connection-manager` переключает: если eth0 упал — переключается на eth1/wifi/4G по приоритетам из конфига. Сам соединения не создаёт — это работа NetworkManager.

## Базовые команды

Используй `network_status` — он одним вызовом возвращает интерфейсы (`ip -j addr`), default-маршрут, активные NM-соединения и устройства, опционально ping. Это first-call для диагностики.

Для прицельных запросов:

```bash
ssh root@<HOST> 'ip -4 route show default | head -1'   # текущий default — какой интерфейс активен как uplink
ssh root@<HOST> 'cat /etc/resolv.conf'                  # текущий DNS
ssh root@<HOST> 'nmcli device wifi list ifname wlan1'   # сканировать WiFi-сети
ssh root@<HOST> 'mmcli -L && mmcli -m 0 --signal-get'   # модемы и сигнал
```

**Активный uplink** = соединение в состоянии `activated` с дефолт-маршрутом через него.

## Подключение к WiFi-сети

```bash
ssh root@<HOST> 'nmcli device wifi connect "<SSID>" password "<pwd>" ifname wlan1'
ssh root@<HOST> 'nmcli connection modify "<SSID>" connection.autoconnect yes'
```

`wlan1` — внешний USB-донгл, если есть. `wlan0` обычно занят точкой доступа `wb-ap`. Если только один WiFi-чип — на время отключи AP: `nmcli connection down wb-ap`.

## Точка доступа (hotspot)

В контроллере уже есть готовый профиль `wb-ap` (SSID `WirenBoard-<SN>`, IP `192.168.42.1/24`, NAT). Меняем:

```bash
ssh root@<HOST> 'nmcli connection modify wb-ap 802-11-wireless.ssid "MyAP"'
ssh root@<HOST> 'nmcli connection modify wb-ap 802-11-wireless-security.key-mgmt wpa-psk wifi-sec.psk "MyPassword123"'
ssh root@<HOST> 'nmcli connection up wb-ap'
```

Открытая сеть → `802-11-wireless-security.key-mgmt none`.

## Статический IP вместо DHCP

```bash
ssh root@<HOST> 'nmcli connection modify wb-eth0 \
  ipv4.method manual \
  ipv4.addresses 192.168.10.50/24 \
  ipv4.gateway 192.168.10.1 \
  ipv4.dns "192.168.10.1 8.8.8.8"'
ssh root@<HOST> 'nmcli connection up wb-eth0'
```

Обратно на DHCP: `ipv4.method auto` + очистить `ipv4.addresses ""`, `ipv4.gateway ""`, `ipv4.dns ""`.

## 4G/GSM (sim1/sim2)

WB7/WB8 — встроенный GSM-модем + 2 SIM-слота. Соединения `wb-gsm-sim1`/`wb-gsm-sim2` пред-настроены.

```bash
ssh root@<HOST> 'nmcli connection up wb-gsm-sim1'    # активировать SIM1
ssh root@<HOST> 'mmcli -m 0'                          # детали модема: signal, IMEI, registration
ssh root@<HOST> 'mmcli -m 0 --signal-get'            # сила сигнала
```

**APN**, если оператор требует руками: `nmcli connection modify wb-gsm-sim1 gsm.apn "internet"`. PIN: `gsm.pin "1234"`.

`wb-connection-manager` переключает между uplink'ами по приоритетам сам, но руками — через `nmcli connection up <name>`.

**Если модем не виден** (`mmcli -L` пуст):
1. `dmesg | grep -iE 'modem|qmi|cdc-wdm|usbserial' | tail -20` — увидел ли его ядро.
2. `systemctl status ModemManager` — драйвер жив?
3. `lsusb` — модем в списке USB?
4. На WB7/WB8 — питание модема и SIM. См. wiki «WB-MOD-MODEM».

## OpenVPN-клиент

Файл `<name>.ovpn` от провайдера VPN:

```bash
scp client.ovpn root@<HOST>:/tmp/
ssh root@<HOST> 'nmcli connection import type openvpn file /tmp/client.ovpn'
ssh root@<HOST> 'nmcli connection modify <name> +vpn.data username=<user>'
ssh root@<HOST> 'nmcli connection modify <name> +vpn.secrets password=<pwd>'
ssh root@<HOST> 'nmcli connection up <name>'
```

Автоконнект — `connection.autoconnect yes`. Проверка — `ip -4 addr show tun0`, `curl -s ifconfig.me`.

`/etc/NetworkManager/system-connections/*.nmconnection` хранит секреты в plaintext — perms `0600`, root-only.

## DNS

`/etc/resolv.conf` — обычно symlink на `/run/NetworkManager/resolv.conf`. **Править руками бесполезно**, перезапишется. Через nmcli:

```bash
ssh root@<HOST> 'nmcli connection modify <conn> ipv4.dns "8.8.8.8 1.1.1.1"'
ssh root@<HOST> 'nmcli connection modify <conn> ipv4.ignore-auto-dns yes'   # игнорить DNS из DHCP
ssh root@<HOST> 'nmcli connection up <conn>'
```

Без `ignore-auto-dns` твой DNS добавится **в конец** списка — DHCP-DNS будет первым.

## wb-connection-manager: приоритеты и failover

Конфиг через `confed/Editor/Load /etc/wb-connection-manager.conf`. В нём `ui.con_switch.connections` — упорядоченный список UUID соединений от наивысшего приоритета к низшему. Failover идёт по нему. Правка через `confed/Editor/Save` (см. `wb-mqtt-serial` — там общий паттерн confed).

**Логи**: `journalctl -u wb-connection-manager -n 50 --no-pager` — что переключилось и почему.

## Диагностика «нет интернета»

1. **Link** — есть ли IP на интерфейсе. См. `network_status`.
2. **Default route** — `ip -4 route show default` существует?
3. **Pinger** — `ping -c1 -W2 8.8.8.8` (без DNS) и `ping -c1 -W2 google.com` (с DNS). Можно через `network_status pingTarget=8.8.8.8`.
4. **DNS** — `cat /etc/resolv.conf`, `nslookup google.com`.
5. **NM logs** — `journalctl -u NetworkManager -n 50 --no-pager` (или `wb_logs unit=NetworkManager`).
6. **wb-connection-manager logs** — `journalctl -u wb-connection-manager -n 30 --no-pager` — что переключал.
7. **Если 4G** — `mmcli -m 0 --signal-get`, `mmcli -m 0 | grep -E 'state|registration'`.

## NM-профили vs wb-connection-manager.conf

NM-профили лежат в `/etc/NetworkManager/system-connections/*.nmconnection`. **Файлы обновляются автоматически** при `nmcli connection modify`. Прямая правка возможна, но требует `chmod 0600` + `systemctl restart NetworkManager`.

`/etc/wb-connection-manager.conf` — слой над ними для UI и приоритетов. Если правишь NM напрямую, помни: confed-конфиг не регенерируется, и веб-UI может показывать устаревшие данные.

**Рекомендация:** простые изменения (SSID, пароль, static IP) — через `nmcli`. Структурные изменения и приоритеты — через `wb_confed_save /etc/wb-connection-manager.conf`.

## Грабли

- **Не проверил link перед DNS** — типичная ошибка. Сначала `ip addr`, потом `ping IP`, потом `ping name`.
- **Правка `/etc/resolv.conf` руками** — перезаписывается NM. Только через `nmcli ipv4.dns`.
- **Поднимаем VPN — теряем доступ к WB-AP** — если VPN ставит default через себя, локальная сеть отваливается. `connection.autoconnect-priority` или ручной старт.
- **`wlan0` под AP** — нельзя одновременно использовать как client. Для WiFi-клиента — второй адаптер (USB).
- **APN провайдера** — без правильного `gsm.apn` модем не получит IP. Уточни у оператора.
- **PIN** — некоторые операторы требуют. Без PIN модем `Locked`.
- **Failover «прыгает»** — слабый GSM-сигнал, плохой WiFi. Лог `wb-connection-manager` покажет где застряло.
- **NM не стартует** — `systemctl status NetworkManager`, kernel mismatch (см. `troubleshooting-general`).
- **Custom .nmconnection не переживёт FIT** — бэкап через `controller-backup`.

## Документация

- NetworkManager: https://networkmanager.dev/docs/
- nmcli reference: `man nmcli`
- ModemManager: https://www.freedesktop.org/wiki/Software/ModemManager/
- WB wiki networking: https://wirenboard.com/wiki/Network
