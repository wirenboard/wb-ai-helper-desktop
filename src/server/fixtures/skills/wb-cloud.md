# wb-cloud

`wb-cloud-agent` — a service on the controller that maintains a tunnel to Wiren Board Cloud (`https://wirenboard.cloud`) for remote access to the web UI and API. Each controller has a cryptographic certificate in protected memory (`ATECCx08`) used to sign the activation.

Load this skill on: "bind controller to the cloud", "activate in wirenboard.cloud", "won't open via the cloud", "unbind from the account", "own cloud backend", "cloud status", "remote access via wirenboard.cloud".

## Architecture

```
Web UI (wirenboard.cloud)
      ↑ (long-poll / websocket)
      │
      ▼
wb-cloud-agent  ──reads──▶  /etc/wb-cloud-agent.conf  (LOG_LEVEL, CLIENT_CERT_ENGINE_KEY, CLOUD_BASE_URL)
      │
      ├── /var/lib/wb-cloud-agent/device_bundle.crt.pem      (device certificate)
      ├── /var/lib/wb-cloud-agent/providers/<provider>/       (per-provider state)
      │
      └── publishes to MQTT:
          /devices/system__wb-cloud-agent__<provider>/controls/status
                                                           /activation_link
                                                           /cloud_base_url
```

Provider — a specific cloud. The default is `wirenboard.cloud`. You can run your own — see below.

## Basic diagnostics

Use the `cloud_status` tool — in a single call it returns: service activity, presence of the device certificate, the list of bound providers, retained MQTT controls (status / activation_link / cloud_base_url) for each one. This is the first call to check "is the controller bound to the cloud and in what status".

Possible values of `status`:
- `unknown` — the agent has just started and hasn't connected yet.
- `ok` (or `active`) — the tunnel is established, the controller is visible from the cloud.
- `not_activated` — the certificate exists, but the device is not bound to an account.
- `error` — check the logs.

## Activation (binding to an account)

1. Make sure the service is running and there is internet:
   ```bash
   ssh root@<HOST> 'systemctl is-active wb-cloud-agent && curl -s -m5 https://wirenboard.cloud >/dev/null && echo ok'
   ```

2. If `inactive` — `systemctl enable --now wb-cloud-agent`.

3. Get the `activation_link` from MQTT:
   ```bash
   ssh root@<HOST> "mosquitto_sub -t '/devices/system__wb-cloud-agent__wirenboard.cloud/controls/activation_link' -C 1 -W 5"
   ```

4. Open the link in a browser, sign in to `wirenboard.cloud`, bind it to the account.

5. After binding, `status` changes to `active` — check via `cloud_status` or mosquitto_sub.

## Unbind / reset activation

```bash
ssh root@<HOST> 'systemctl stop wb-cloud-agent'
ssh root@<HOST> 'rm -rf /var/lib/wb-cloud-agent/providers/wirenboard.cloud/'
ssh root@<HOST> 'systemctl start wb-cloud-agent'
```

After this, the agent issues a new `activation_link`. The old binding in the `wirenboard.cloud` account remains, but points to nowhere — delete it manually via the cloud web UI.

## Own cloud backend

`CLOUD_BASE_URL` in `/etc/wb-cloud-agent.conf` points to the cloud address. Default is `https://wirenboard.cloud/`. To switch it:

```bash
ssh root@<HOST> 'cat > /etc/wb-cloud-agent.conf' <<'EOF'
{
    "LOG_LEVEL": "INFO",
    "CLIENT_CERT_ENGINE_KEY": "ATECCx08:00:02:C0:00",
    "CLOUD_BASE_URL": "https://my.cloud.example/"
}
EOF
ssh root@<HOST> 'systemctl restart wb-cloud-agent'
```

Your own backend must implement an API compatible with `wirenboard.cloud`. This is a rare case — usually for self-hosted deployments or test benches. The ATECC certificate is still signed by Wiren Board, but you can verify it against your CA if you trust the WB root.

## Diagnostics of "won't connect to the cloud"

1. **Is the service active?** `cloud_status` — `serviceActive`. If `false` → `enable --now`.
2. **Is the certificate present?** `cloud_status` — `certPresent`. No — the controller is not a Wiren Board one or the ATECC is broken.
3. **Internet outbound?** `curl -s -m5 https://wirenboard.cloud >/dev/null && echo ok`. No — see `wb-network` (failover, DNS).
4. **Logs**: `wb_logs unit=wb-cloud-agent lines=100`. Typical errors:
   - `connection refused` / `timeout` — a network problem.
   - `Certificate verification failed` — wrong date on the controller (`date`), sync NTP.
   - `Authentication failed` — the certificate is revoked / the device was deleted from the cloud.
5. **Is MQTT publishing?** `cloud_status` → `mqtt`. Empty — the agent didn't reach the publishing stage, check the logs.

## Related skills

- `wb-network` — if the cloud is unreachable due to internet.
- `wb-services` — `wb-cloud-agent` is a systemd unit; override-conf and mask/unmask are there.
- `controller-backup` — `/etc/wb-cloud-agent.conf` is already in the core-tar; `/var/lib/wb-cloud-agent/providers/` is usually NOT backed up (a new activation gives a new providers state, which is fine).
- `troubleshooting-general` — general diagnostics, kernel mismatch, disk space.

## Pitfalls

- **Time drifts significantly** — the TLS handshake to the cloud will fail. NTP must work (`systemctl is-active ntp` or `systemd-timesyncd`).
- **VPN on the controller with a default route** — may cut off access to the cloud if the VPN server blocks outbound `wirenboard.cloud`. Check the route: `ip route get $(getent hosts wirenboard.cloud | awk "{print \$1}")`.
- **`CLIENT_CERT_ENGINE_KEY`** — do NOT edit it by hand. It is the certificate's address in the ATECC, a factory setting.
- **Deleted the controller in the web UI without a local reset** — the local agent will keep hammering with `Authentication failed`. Do a local cleanup of `providers/` + restart.
- **Activation link is single-use** — if you clicked but didn't complete activation, the agent generates a new one on the next request/restart.

## Documentation

- WB Cloud: https://wirenboard.com/wiki/Wiren_Board_Cloud
- Remote access: https://wirenboard.com/wiki/Remote_access
