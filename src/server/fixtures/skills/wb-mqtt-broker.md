# wb-mqtt-broker

Administering `mosquitto` on the controller: external listeners, passwords, ACLs, bridges to foreign brokers, TLS. Configs are in `/etc/mosquitto/conf.d/*.conf` (do NOT edit `mosquitto.conf` directly).

Load this skill on: "open MQTT to the outside", "passwords on MQTT", "set up TLS", "bridge to the cloud", "bridge to Home Assistant", "can't connect to MQTT from a laptop", "mosquitto", "ACL for MQTT", "encrypt MQTT".

## Config structure

```
/etc/mosquitto/mosquitto.conf            # includes 3 directories in order:
  /usr/share/wb-configs/mosquitto/        # WB defaults — DON'T touch
  /etc/mosquitto/conf.d/                  # user — write here
  /usr/share/wb-configs/mosquitto-post/   # WB post — DON'T touch

/etc/mosquitto/conf.d/
├── 00default_listener.conf   # Unix socket for WB services (DON'T touch)
├── 10listeners.conf          # external listeners (1883, 8883) — yours
├── 20bridges.conf            # bridges — yours
└── 21bridge.conf.example     # bridge template

/etc/mosquitto/passwd/        # passwords (mosquitto_passwd -c)
/etc/mosquitto/acl/           # ACLs (topics per user)
/etc/mosquitto/certs/         # TLS certificates
```

**Principle:** WB services communicate via the Unix socket `/var/run/mosquitto/mosquitto.sock` (anonymously, through `00default_listener`). External clients — via 1883/8883, authentication only there.

By default (factory): listener 1883 anonymous = the broker is open to the world. **In production, close it.**

## Basic commands

```bash
ssh root@<HOST> 'systemctl is-active mosquitto'
ssh root@<HOST> 'mosquitto -c /etc/mosquitto/mosquitto.conf -t'        # config check without restart
ssh root@<HOST> 'journalctl -u mosquitto -n 50 --no-pager'
ssh root@<HOST> "mosquitto_sub -h localhost -t '\$SYS/broker/clients/connected' -C 1"
```

## Passwords

### Creating a password file

```bash
ssh root@<HOST> 'mkdir -p /etc/mosquitto/passwd; chown mosquitto:mosquitto /etc/mosquitto/passwd'
ssh root@<HOST> 'mosquitto_passwd -c /etc/mosquitto/passwd/default.conf <username>'
# you enter the password interactively
ssh root@<HOST> 'chown mosquitto:mosquitto /etc/mosquitto/passwd/default.conf; chmod 0640 /etc/mosquitto/passwd/default.conf'
```

`-c` — create (overwrites the existing one!). Without `-c` — add a user to an existing file. Delete: `mosquitto_passwd -D /etc/mosquitto/passwd/default.conf <username>`.

### Attaching passwords to a listener

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

`per_listener_settings true` (in `00default_listener.conf`) is key: it allows a different `allow_anonymous` for different listeners. The internal socket — anonymous, the external one — password.

## ACL — topic permissions

```bash
ssh root@<HOST> 'cat > /etc/mosquitto/acl/default.conf' <<'EOF'
# By default anonymous — deny
topic deny #

# admin — full access
user admin
topic readwrite #

# frontend — read /devices/, write only to /on
user frontend
topic read /devices/#
topic write /devices/+/controls/+/on

# external_app — only its own namespace
user external_app
topic readwrite app/external_app/#
EOF
ssh root@<HOST> 'systemctl reload mosquitto'   # the ACL file is re-read without a full restart
```

**Internal WB services via the Unix socket are not subject to the ACL** — they have their own section in `00default_listener.conf` (`allow_anonymous true`, without `acl_file`).

## TLS on 8883

### Certificates (self-signed for home)

For production — Let's Encrypt via certbot/acme.sh with a public domain.

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

From an external host, distribute `ca.crt` to the client and connect to `wirenboard-<SN>.local:8883`. Without `--cafile` a self-signed cert → `certificate verify failed`.

## Bridges to other brokers

Mosquitto connects to a foreign broker itself and copies selected topics. Use cases: replication to Home Assistant, a copy to the cloud, a backup broker.

### Example: bridge to Home Assistant

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
- `out` — publish there, `in` — pull here, `both` — both directions.
- `wb/A25NDEMJ/` — the prefix on the remote side.

`cleansession false` — on disconnect, messages with QoS≥1 accumulate and are delivered after recovery.

### Bridge with TLS

```
bridge_cafile /etc/mosquitto/certs/ha-ca.crt
bridge_certfile /etc/mosquitto/certs/wb-client.crt
bridge_keyfile /etc/mosquitto/certs/wb-client.key
bridge_insecure false
```

`bridge_insecure true` disables hostname verification — for debugging only.

## Changes without a restart

`systemctl reload mosquitto` re-reads only `password_file` and `acl_file`. Listeners, bridges, TLS — `restart` (~1 sec downtime; WB services on the Unix socket survive it).

## Backup and FIT

`/etc/mosquitto/conf.d/`, `/etc/mosquitto/passwd/`, `/etc/mosquitto/acl/`, `/etc/mosquitto/certs/` — do **not survive FIT**. They are picked up via `/wb-controller-backup`.

## Pitfalls

- **`per_listener_settings false`** (Debian package default) — `allow_anonymous` is global, a separate mode for the Unix socket is impossible. The WB config sets `true` — don't reset it.
- **Editing `/etc/mosquitto/mosquitto.conf` directly** — may get overwritten by an update. Write everything to `conf.d/`.
- **Closed 1883 anonymous, forgot about WB services** — they are on the Unix socket, not affected. But `per_listener_settings false` breaks everything.
- **`mosquitto_passwd` without `-c` for a new file** — the password won't be saved. With `-c` for an existing file — it wipes everyone.
- **`password_file` without reload** — passwords are picked up on `systemctl reload mosquitto`, a full restart is not needed.
- **ACL without an explicit `topic deny #`** — anonymous (if allow_anonymous true) gets `readwrite` by default.
- **Bridge without `cleansession false`** — message loss on disconnect.
- **`try_private true`** — a mosquitto↔mosquitto feature; for foreign brokers leave it `false`.
- **TLS certificate expired** — `journalctl -u mosquitto` will highlight it, clients get `tls handshake failure`.
- **Permissions on `/etc/mosquitto/passwd/default.conf`** — must be `mosquitto:mosquitto 0640`, otherwise `Unable to open password file ... Permission denied`.

## Documentation

- `man mosquitto.conf`, https://mosquitto.org/man/mosquitto-conf-5.html
- ACL: https://mosquitto.org/documentation/dynamic-security/
- mosquitto_passwd: https://mosquitto.org/man/mosquitto_passwd-1.html
- Bridges: https://mosquitto.org/documentation/bridges/
