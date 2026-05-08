# wb-mqtt-broker

Администрирование `mosquitto` на контроллере: внешние listeners, пароли, ACL, мосты к чужим брокерам, TLS. Конфиги — `/etc/mosquitto/conf.d/*.conf` (НЕ редактируй `mosquitto.conf` напрямую).

Подгружай на: «открыть MQTT наружу», «пароли на MQTT», «настрой TLS», «мост в облако», «мост в Home Assistant», «не подключиться к MQTT с ноута», «mosquitto», «ACL для MQTT», «зашифровать MQTT».

## Структура конфигов

```
/etc/mosquitto/mosquitto.conf            # включает 3 директории по порядку:
  /usr/share/wb-configs/mosquitto/        # WB defaults — НЕ трогай
  /etc/mosquitto/conf.d/                  # пользовательские — пиши сюда
  /usr/share/wb-configs/mosquitto-post/   # WB post — НЕ трогай

/etc/mosquitto/conf.d/
├── 00default_listener.conf   # Unix-сокет для wb-сервисов (НЕ трогай)
├── 10listeners.conf          # внешние listeners (1883, 8883) — твой
├── 20bridges.conf            # мосты — твой
└── 21bridge.conf.example     # шаблон моста

/etc/mosquitto/passwd/        # пароли (mosquitto_passwd -c)
/etc/mosquitto/acl/           # ACL (топики per-user)
/etc/mosquitto/certs/         # TLS-сертификаты
```

**Принцип:** WB-сервисы общаются через Unix-сокет `/var/run/mosquitto/mosquitto.sock` (анонимно, через `00default_listener`). Внешние клиенты — через 1883/8883, аутентификация только там.

По умолчанию (factory): listener 1883 anonymous = брокер открыт миру. **На бою закрывай.**

## Базовые команды

```bash
ssh root@<HOST> 'systemctl is-active mosquitto'
ssh root@<HOST> 'mosquitto -c /etc/mosquitto/mosquitto.conf -t'        # проверка конфига без рестарта
ssh root@<HOST> 'journalctl -u mosquitto -n 50 --no-pager'
ssh root@<HOST> "mosquitto_sub -h localhost -t '\$SYS/broker/clients/connected' -C 1"
```

## Пароли

### Создание файла паролей

```bash
ssh root@<HOST> 'mkdir -p /etc/mosquitto/passwd; chown mosquitto:mosquitto /etc/mosquitto/passwd'
ssh root@<HOST> 'mosquitto_passwd -c /etc/mosquitto/passwd/default.conf <username>'
# вводишь пароль интерактивно
ssh root@<HOST> 'chown mosquitto:mosquitto /etc/mosquitto/passwd/default.conf; chmod 0640 /etc/mosquitto/passwd/default.conf'
```

`-c` — создать (перетирает существующий!). Без `-c` — добавить пользователя в существующий. Удалить: `mosquitto_passwd -D /etc/mosquitto/passwd/default.conf <username>`.

### Подключить пароли к listener

`/etc/mosquitto/conf.d/10listeners.conf`:

```bash
ssh root@<HOST> 'cat > /etc/mosquitto/conf.d/10listeners.conf' <<'EOF'
listener 1883
allow_anonymous false
acl_file /etc/mosquitto/acl/default.conf
password_file /etc/mosquitto/passwd/default.conf
EOF
ssh root@<HOST> 'systemctl restart mosquitto'
```

`per_listener_settings true` (в `00default_listener.conf`) ключевой: позволяет разный `allow_anonymous` для разных listeners. Внутренний сокет — анонимно, внешний — пароль.

## ACL — права на топики

```bash
ssh root@<HOST> 'cat > /etc/mosquitto/acl/default.conf' <<'EOF'
# По умолчанию anonymous — deny
topic deny #

# admin — полный доступ
user admin
topic readwrite #

# frontend — чтение /devices/, запись только в /on
user frontend
topic read /devices/#
topic write /devices/+/controls/+/on

# external_app — только свой namespace
user external_app
topic readwrite app/external_app/#
EOF
ssh root@<HOST> 'systemctl reload mosquitto'   # ACL-файл перечитывается без полного рестарта
```

**Внутренние WB-сервисы через Unix-сокет ACL не подчиняются** — у них своя секция в `00default_listener.conf` (`allow_anonymous true`, без `acl_file`).

## TLS на 8883

### Сертификаты (self-signed для дома)

Для прода — Let's Encrypt через certbot/acme.sh с публичным доменом.

```bash
ssh root@<HOST> 'mkdir -p /etc/mosquitto/certs && cd /etc/mosquitto/certs && \
  openssl genrsa -out ca.key 2048 && \
  openssl req -x509 -new -nodes -key ca.key -sha256 -days 3650 -out ca.crt -subj "/CN=WB-MQTT-CA" && \
  openssl genrsa -out server.key 2048 && \
  openssl req -new -key server.key -out server.csr -subj "/CN=wirenboard-A25NDEMJ.local" && \
  openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out server.crt -days 3650 -sha256 && \
  chown mosquitto:mosquitto *.key *.crt && chmod 0640 *.key'
```

### TLS listener

```bash
ssh root@<HOST> 'cat >> /etc/mosquitto/conf.d/10listeners.conf' <<'EOF'

listener 8883
allow_anonymous false
acl_file /etc/mosquitto/acl/default.conf
password_file /etc/mosquitto/passwd/default.conf
cafile /etc/mosquitto/certs/ca.crt
certfile /etc/mosquitto/certs/server.crt
keyfile /etc/mosquitto/certs/server.key
EOF
ssh root@<HOST> 'systemctl restart mosquitto'
```

С внешнего хоста раздай `ca.crt` клиенту, подключайся к `wirenboard-<SN>.local:8883`. Без `--cafile` self-signed → `certificate verify failed`.

## Мосты к другим брокерам

Mosquitto сам подключается к чужому брокеру и копирует выбранные топики. Кейсы: репликация в Home Assistant, копия в облако, резервный брокер.

### Пример: мост в Home Assistant

```bash
ssh root@<HOST> 'cat > /etc/mosquitto/conf.d/20bridges.conf' <<'EOF'
connection ha-bridge
address ha.local:1883
topic /devices/# out 0 wb/A25NDEMJ/
topic ha/wb/cmd/+ in 0
remote_username <ha_mqtt_user>
remote_password <ha_mqtt_password>
keepalive_interval 60
restart_timeout 10
notifications true
notifications_topic wb/A25NDEMJ/bridge/state
cleansession false
try_private false
EOF
ssh root@<HOST> 'systemctl restart mosquitto'
```

`topic <pattern> <direction> <qos> <local-prefix> <remote-prefix>`:
- `out` — публиковать туда, `in` — притягивать сюда, `both` — оба направления.
- `wb/A25NDEMJ/` — префикс на удалённой стороне.

`cleansession false` — при дисконнекте сообщения с QoS≥1 копятся и доставляются после восстановления.

### Мост с TLS

```
bridge_cafile /etc/mosquitto/certs/ha-ca.crt
bridge_certfile /etc/mosquitto/certs/wb-client.crt
bridge_keyfile /etc/mosquitto/certs/wb-client.key
bridge_insecure false
```

`bridge_insecure true` отключает hostname verification — только для дебага.

## Изменения без рестарта

`systemctl reload mosquitto` перечитывает только `password_file` и `acl_file`. Listeners, мосты, TLS — `restart` (~1 сек простоя; WB-сервисы на Unix-сокете переживают).

## Бэкап и FIT

`/etc/mosquitto/conf.d/`, `/etc/mosquitto/passwd/`, `/etc/mosquitto/acl/`, `/etc/mosquitto/certs/` — **не переживают FIT**. Через `/wb-controller-backup` подцепляются.

## Грабли

- **`per_listener_settings false`** (дефолт Debian-пакета) — `allow_anonymous` глобально, отдельный режим для Unix-сокета невозможен. WB-конфиг ставит `true` — не сбрасывай.
- **Правка `/etc/mosquitto/mosquitto.conf` напрямую** — может перетереться апдейтом. Всё пиши в `conf.d/`.
- **Закрыл 1883 anonymous, забыл про WB-сервисы** — они на Unix-сокете, не задеты. Но `per_listener_settings false` всё ломает.
- **`mosquitto_passwd` без `-c` для нового файла** — пароль не сохранится. С `-c` для существующего — затрёт всех.
- **`password_file` без reload** — пароли подхватываются на `systemctl reload mosquitto`, полный рестарт не нужен.
- **ACL без явного `topic deny #`** — anonymous (если allow_anonymous true) получает `readwrite` по умолчанию.
- **Мост без `cleansession false`** — потери сообщений на дисконнекте.
- **`try_private true`** — фишка mosquitto↔mosquitto, для чужих брокеров оставляй `false`.
- **TLS-сертификат истёк** — `journalctl -u mosquitto` подсветит, клиенты получают `tls handshake failure`.
- **Права на `/etc/mosquitto/passwd/default.conf`** — обязательно `mosquitto:mosquitto 0640`, иначе `Unable to open password file ... Permission denied`.

## Документация

- `man mosquitto.conf`, https://mosquitto.org/man/mosquitto-conf-5.html
- ACL: https://mosquitto.org/documentation/dynamic-security/
- mosquitto_passwd: https://mosquitto.org/man/mosquitto_passwd-1.html
- Bridges: https://mosquitto.org/documentation/bridges/
