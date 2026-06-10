# wb-mqtt-serial

Modbus/RS-485 driver. Config `/etc/wb-mqtt-serial.conf`, templates `/usr/share/wb-mqtt-serial/templates/` (packaged, don't touch) and `/etc/wb-mqtt-serial.conf.d/templates/` (your own). Access via RPC `wb-mqtt-serial/...`, not through files. Load this skill on: "channel is not published", "I don't see the device on the bus", "polling froze", "enable channel X", "scan the bus", "slave_id / holding / coil / input register", enabling/disabling channels, adding/removing/editing devices in the wb-mqtt-serial config, "add a modbus device", "delete a device", "clear the device list", "change the serial config", "wb-mqtt-serial.conf", editing ports/devices in the config.

**Skill boundary:** if you need to create a template for a device that isn't among the built-in ones — that's the `wb-mqtt-serial-template` skill. If the problem is with signal/CRC/timeouts — `troubleshooting-serial` (or `rs485-diagnose` if there's an OWON).

## RPC, not files

Template from firmware → `device/LoadConfig`. Config → `config/Load`. Write → `confed/Editor/Save` (validation + service restart atomically; broken JSON isn't written, bus polling stays alive). A direct `write_file` into `.conf` — only with a backup and deliberately.

- **"Channel not in MQTT" ≠ "not supported".** Many template channels ship with `"enabled": false` (Uptime, Counter, Total, Serial). First `device/LoadConfig`, then conclusions.
- **Look for the template on the controller, not on GitHub.** The one on the device is current for the firmware. A `web_fetch` of templates is almost always wasted.
- **A custom template is a last resort.** First check the built-in one.
- **The bus scan is slow.** `port/Scan mode=all` takes 5-30 sec, set `timeoutSec ≥ 30`.

## RPC via mqtt_rpc

`params` — a nested object, a required field (even an empty `{}`).

```jsonc
// Device template — all channels, including enabled:false
mqtt_rpc({ sn, driver: "wb-mqtt-serial", service: "device", method: "LoadConfig",
  params: { device_id: "wb-mr6c_138" }
  // or by address: { path: "/dev/ttyRS485-1", baud_rate: 9600, parity: "N",
  //                  data_bits: 8, stop_bits: 2, slave_id: 138, device_type: "WB-MR6C" }
})

// Current config
mqtt_rpc({ sn, driver: "wb-mqtt-serial", service: "config", method: "Load", params: {} })

// Save the config (validation + restart)
mqtt_rpc({ sn, driver: "confed", service: "Editor", method: "Save",
  params: { path: "/etc/wb-mqtt-serial.conf", content: "<the entire updated JSON>" }
})

// Bus scan (Fast Modbus)
mqtt_rpc({ sn, driver: "wb-mqtt-serial", service: "port", method: "Scan",
  params: { path: "/dev/ttyRS485-1", baud_rate: 9600, mode: "all" }, timeoutSec: 30
})

// Targeted slave_id check
mqtt_rpc({ sn, driver: "wb-mqtt-serial", service: "port", method: "Probe",
  params: { path: "/dev/ttyRS485-1", baud_rate: 9600, slave_id: 138 }
})
```

Other: `device/Load` — live channel values; `device/Set` — write `{"channel_name": value}` (only on an explicit user request).

## Scenario "enable channel X on device Y"

1. `mqtt_list_topics(sn, prefix="/devices/+/meta/name")` — find the `device_id`.
2. `device/LoadConfig({device_id})` — all channels and their `enabled`.
3. `config/Load({})` — find the device in `ports[*].devices[*]`.
4. Edit the JSON — add/update the channel entry, set `"enabled": true`.
5. Show the user the diff, warn about the wb-mqtt-serial restart (polling freezes for ~5-10 sec).
6. `confed/Editor/Save` with the full new JSON.
7. After 10-20 sec: `mqtt_read(sn, "/devices/<device_id>/controls/<channel>")`.

## Scenario "what is connected on the bus"

1. Ports: `ssh_exec(sn, "ls /dev/ttyRS485-* /dev/ttyMOD*")` or from `config/Load`.
2. `port/Scan` (`wb-mqtt-serial/port/Scan`) with `timeoutSec=30` on each port — shows what the driver sees. Finds only WB and Onokom (Fast Modbus).
3. Compare with `config/Load` — what is already described, what to add.

> `port/Scan` (this skill) — a management tool of the driver. `wb_bus_scan` (the `troubleshooting-serial` skill) — a diagnostic tool via `wb-device-manager`. Different services, different purposes — don't confuse them.

## Channel error flags (WB MQTT Conventions)

Each control has a meta-topic `/devices/<dev>/controls/<ch>/meta/error` with a string of characters:

| Flag | Meaning |
|---|---|
| `r` | read error — the last register poll failed (CRC, timeout, exception) |
| `w` | write error — the write to the register didn't go through |
| `p` | period miss — the driver can't keep up polling at the set rate (slow registers, busy bus) |

An empty string / no topic = everything is fine. Multiple flags come in a row (`rp`, `rwp`).

**Important:** with `r`, the value in `/devices/<dev>/controls/<ch>` is the **last successfully read** one (last-known-good), NOT fresh. Don't read a control without checking `meta/error` — you risk taking a stale value for the current one.

```jsonc
// Scenario "check whether the channel is alive":
mqtt_read(sn, "/devices/wb-mr6c_138/controls/Input 1/meta/error")
// → "" — ok, the value is fresh
// → "r" — the last read failed, the value is stale
// → "p" — the driver can't keep up; either polling is slow, or the bus is overloaded

mqtt_read(sn, "/devices/wb-mr6c_138/controls/Input 1")  // last-known-good if r=true
```

**Where it's visible in the UI:** on the Devices page, a control with an active error flag is highlighted yellow/red.

**What to do on `r`/`rp`:** see `troubleshooting-serial` — usually bus physics (terminators, length, contact) or a `slave_id` collision. With only `p` — increase `read_rate_limit_ms` for heavy channels or reduce polling of unused ones.

## Direct file editing — a backup is mandatory

If done without `confed/Editor/Save` (via `write_file` or `ssh_exec`) — back up first, then `systemctl restart wb-mqtt-serial`:

```bash
ssh_exec(sn, "cp /etc/wb-mqtt-serial.conf /etc/wb-mqtt-serial.conf.bak-$(date +%s)")
```

## Pitfalls

- "Channel not supported" based on `mqtt_list_topics` without `LoadConfig` — see above, `enabled:false` is not published.
- `web_fetch` of a template from GitHub instead of `LoadConfig` — the one on the device is more current.
- A custom template before checking the built-in one.
- A direct `write_file` into `.conf` without validation — broken JSON will kill bus polling.
- Editing packaged templates in `/usr/share/...` — they get overwritten by an update. Custom ones — only in `/etc/wb-mqtt-serial.conf.d/templates/`.
- `port/Scan` without `timeoutSec ≥ 30` → timeout, partial response.

## Documentation

- Wiki: <https://wirenboard.com/wiki/wb-mqtt-serial>
- Sources + templates: <https://github.com/wirenboard/wb-mqtt-serial>
- Module pages: `https://wirenboard.com/wiki/<Model>` (WB-MR6C, WB-MSW_v.4, etc.)
