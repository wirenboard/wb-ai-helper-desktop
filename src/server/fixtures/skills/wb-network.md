# wb-network

The networking subsystem of the Wiren Board controller: **NetworkManager** manages physical connections (eth0/eth1/wlan0/ppp0/...), **wb-connection-manager** sets priorities between them and does automatic failover. The config `/etc/wb-connection-manager.conf` (via `confed`) is the single source of truth for the web UI.

Load on: "set up 4G", "give internet via sim1", "WiFi access point", "no external ping", "static IP", "set up DNS", "eth1 won't connect", "modem won't connect", "failover not working", "OpenVPN client", "network parameters".

**Boundary:** general "something is broken" diagnostics — `troubleshooting-general`. This skill is for targeted configuration.

## Architecture

```
┌─────────────────────────────────────────────────┐
│  /etc/wb-connection-manager.conf  (confed UI)   │
│  └─ data:    physical interfaces                │
│  └─ ui:      priorities, types, visible in WebUI│
└────────────────────┬────────────────────────────┘
                     │ wb-connection-manager
                     ▼
┌─────────────────────────────────────────────────┐
│  NetworkManager (nmcli)                         │
│  └─ /etc/NetworkManager/system-connections/*.nmconnection │
│  └─ manages ip / route / dns                    │
└─────────────────────────────────────────────────┘
```

`wb-connection-manager` switches over: if eth0 goes down — it switches to eth1/wifi/4G by the priorities from the config. It does not create the connections itself — that's NetworkManager's job.

## Basic commands

Use `network_status` — in a single call it returns the interfaces (`ip -j addr`), the default route, active NM connections and devices, and optionally a ping. This is the first call for diagnostics.

For targeted queries:

```bash
ssh root@<HOST> 'ip -4 route show default | head -1'   # current default — which interface is the active uplink
ssh root@<HOST> 'cat /etc/resolv.conf'                  # current DNS
ssh root@<HOST> 'nmcli device wifi list ifname wlan1'   # scan WiFi networks
ssh root@<HOST> 'mmcli -L && mmcli -m 0 --signal-get'   # modems and signal
```

**Active uplink** = a connection in the `activated` state with the default route going through it.

## Connecting to a WiFi network

```bash
ssh root@<HOST> 'nmcli device wifi connect "<SSID>" password "<pwd>" ifname wlan1'
ssh root@<HOST> 'nmcli connection modify "<SSID>" connection.autoconnect yes'
```

`wlan1` — an external USB dongle, if present. `wlan0` is usually occupied by the `wb-ap` access point. If there's only one WiFi chip — temporarily disable the AP: `nmcli connection down wb-ap`.

## Access point (hotspot)

The controller already has a ready-made `wb-ap` profile (SSID `WirenBoard-<SN>`, IP `192.168.42.1/24`, NAT). To change it:

```bash
ssh root@<HOST> 'nmcli connection modify wb-ap 802-11-wireless.ssid "MyAP"'
ssh root@<HOST> 'nmcli connection modify wb-ap 802-11-wireless-security.key-mgmt wpa-psk wifi-sec.psk "MyPassword123"'
ssh root@<HOST> 'nmcli connection up wb-ap'
```

Open network → `802-11-wireless-security.key-mgmt none`.

## Static IP instead of DHCP

```bash
ssh root@<HOST> 'nmcli connection modify wb-eth0 \
  ipv4.method manual \
  ipv4.addresses 192.168.10.50/24 \
  ipv4.gateway 192.168.10.1 \
  ipv4.dns "192.168.10.1 8.8.8.8"'
ssh root@<HOST> 'nmcli connection up wb-eth0'
```

Back to DHCP: `ipv4.method auto` + clear `ipv4.addresses ""`, `ipv4.gateway ""`, `ipv4.dns ""`.

## 4G/GSM (sim1/sim2)

WB7/WB8 — built-in GSM modem + 2 SIM slots. The `wb-gsm-sim1`/`wb-gsm-sim2` connections are pre-configured.

```bash
ssh root@<HOST> 'nmcli connection up wb-gsm-sim1'    # activate SIM1
ssh root@<HOST> 'mmcli -m 0'                          # modem details: signal, IMEI, registration
ssh root@<HOST> 'mmcli -m 0 --signal-get'            # signal strength
```

**APN**, if the operator requires it manually: `nmcli connection modify wb-gsm-sim1 gsm.apn "internet"`. PIN: `gsm.pin "1234"`.

`wb-connection-manager` switches between uplinks by priority on its own, but to do it manually — use `nmcli connection up <name>`.

**If the modem is not visible** (`mmcli -L` is empty):
1. `dmesg | grep -iE 'modem|qmi|cdc-wdm|usbserial' | tail -20` — did the kernel see it.
2. `systemctl status ModemManager` — is the driver alive?
3. `lsusb` — is the modem in the USB list?
4. On WB7/WB8 — modem and SIM power. See the wiki "WB-MOD-MODEM".

## OpenVPN client

A `<name>.ovpn` file from the VPN provider:

```bash
scp client.ovpn root@<HOST>:/tmp/
ssh root@<HOST> 'nmcli connection import type openvpn file /tmp/client.ovpn'
ssh root@<HOST> 'nmcli connection modify <name> +vpn.data username=<user>'
ssh root@<HOST> 'nmcli connection modify <name> +vpn.secrets password=<pwd>'
ssh root@<HOST> 'nmcli connection up <name>'
```

Autoconnect — `connection.autoconnect yes`. Check — `ip -4 addr show tun0`, `curl -s ifconfig.me`.

`/etc/NetworkManager/system-connections/*.nmconnection` stores secrets in plaintext — perms `0600`, root-only.

## DNS

`/etc/resolv.conf` — usually a symlink to `/run/NetworkManager/resolv.conf`. **Editing it by hand is pointless**, it will be overwritten. Via nmcli:

```bash
ssh root@<HOST> 'nmcli connection modify <conn> ipv4.dns "8.8.8.8 1.1.1.1"'
ssh root@<HOST> 'nmcli connection modify <conn> ipv4.ignore-auto-dns yes'   # ignore DNS from DHCP
ssh root@<HOST> 'nmcli connection up <conn>'
```

Without `ignore-auto-dns` your DNS is appended **to the end** of the list — the DHCP DNS will be first.

## wb-connection-manager: priorities and failover

Config via `confed/Editor/Load /etc/wb-connection-manager.conf`. In it, `ui.con_switch.connections` is an ordered list of connection UUIDs from highest priority to lowest. Failover follows it. Edit via `confed/Editor/Save` (see `wb-mqtt-serial` — the common confed pattern is there).

**Logs**: `journalctl -u wb-connection-manager -n 50 --no-pager` — what switched and why.

## Diagnosing "no internet"

1. **Link** — is there an IP on the interface. See `network_status`.
2. **Default route** — does `ip -4 route show default` exist?
3. **Pinger** — `ping -c1 -W2 8.8.8.8` (without DNS) and `ping -c1 -W2 google.com` (with DNS). Can be done via `network_status pingTarget=8.8.8.8`.
4. **DNS** — `cat /etc/resolv.conf`, `nslookup google.com`.
5. **NM logs** — `journalctl -u NetworkManager -n 50 --no-pager` (or `wb_logs unit=NetworkManager`).
6. **wb-connection-manager logs** — `journalctl -u wb-connection-manager -n 30 --no-pager` — what it switched.
7. **If 4G** — `mmcli -m 0 --signal-get`, `mmcli -m 0 | grep -E 'state|registration'`.

## NM profiles vs wb-connection-manager.conf

NM profiles live in `/etc/NetworkManager/system-connections/*.nmconnection`. **The files are updated automatically** on `nmcli connection modify`. Direct editing is possible, but requires `chmod 0600` + `systemctl restart NetworkManager`.

`/etc/wb-connection-manager.conf` is a layer above them for the UI and priorities. If you edit NM directly, remember: the confed config is not regenerated, and the web UI may show stale data.

**Recommendation:** simple changes (SSID, password, static IP) — via `nmcli`. Structural changes and priorities — via `wb_confed_save /etc/wb-connection-manager.conf`.

## Pitfalls

- **Didn't check the link before DNS** — a typical mistake. First `ip addr`, then `ping IP`, then `ping name`.
- **Editing `/etc/resolv.conf` by hand** — overwritten by NM. Only via `nmcli ipv4.dns`.
- **Bringing up the VPN — losing access to WB-AP** — if the VPN sets the default route through itself, the local network drops out. `connection.autoconnect-priority` or a manual start.
- **`wlan0` is under the AP** — it can't be used as a client at the same time. For a WiFi client — a second adapter (USB).
- **Provider's APN** — without the correct `gsm.apn` the modem won't get an IP. Check with the operator.
- **PIN** — some operators require it. Without a PIN the modem is `Locked`.
- **Failover "jumps"** — weak GSM signal, poor WiFi. The `wb-connection-manager` log will show where it got stuck.
- **NM won't start** — `systemctl status NetworkManager`, kernel mismatch (see `troubleshooting-general`).
- **A custom .nmconnection won't survive a FIT** — back up via `controller-backup`.

## Documentation

- NetworkManager: https://networkmanager.dev/docs/
- nmcli reference: `man nmcli`
- ModemManager: https://www.freedesktop.org/wiki/Software/ModemManager/
- WB wiki networking: https://wirenboard.com/wiki/Network
