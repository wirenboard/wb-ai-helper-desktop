# wb-serial-templates

Creating your own Modbus templates for `wb-mqtt-serial`. Needed when the manufacturer is not WB/Onokom (no built-in template) or when adding your own registers to an existing one.

Load on: "no template for the device", "add a third-party Modbus device", "create a template", "how to add custom registers", "template for an electricity meter", "Modbus thermometer".

## Where templates live

| Directory | What | Editable? |
|---|---|---|
| `/usr/share/wb-mqtt-serial/templates/config-<id>.json` | WB and Onokom templates (packaged) | NO — overwritten by `apt upgrade` |
| `/etc/wb-mqtt-serial.conf.d/templates/<name>.json` | Custom templates | Yes, survive upgrades |
| `/etc/wb-mqtt-serial.conf.d/confs/*.conf` | Custom pieces of the main config | Less often |

`wb-mqtt-serial` scans both directories on startup. A custom template with the same `device_type` as a packaged one **overrides** the packaged one (useful for patches; risky — you might forget).

## Minimal template

```json
{
  "title": "ACME EM-100 (1-phase energy meter)",
  "device_type": "ACME-EM100",
  "group": "g_energy_meters",
  "device": {
    "name": "ACME EM-100",
    "id": "acme-em100",
    "channels": [
      {"name": "Voltage", "reg_type": "input", "address": 0, "format": "u16", "scale": 0.1, "type": "voltage", "units": "V"},
      {"name": "Current", "reg_type": "input", "address": 2, "format": "u32", "scale": 0.001, "type": "current", "units": "A"}
    ]
  }
}
```

`device_type` goes into `/etc/wb-mqtt-serial.conf` (`ports[*].devices[*].device_type`).
`device.id` — the MQTT topic prefix (`/devices/<id>_<slave_id>/...`).

## Channel fields (full set)

| Field | Purpose |
|---|---|
| `name` | Control name in MQTT (spaces allowed: `Input 0 counter`) |
| `reg_type` | `coil` (FC1, RW), `discrete` (FC2, RO), `holding` (FC3, RW), `input` (FC4, RO) |
| `address` | Register address (decimal) |
| `format` | `u8/s8/u16/s16/u32/s32/u64/s64`, `bcd16/bcd32/bcd64`, `float`, `double`, `string`, `varstring` |
| `scale` | Multiplier: `value = raw * scale` |
| `offset` | Added after scale |
| `round_to` | Round to N digits |
| `type` | Control type: `switch`, `value`, `voltage`, `current`, `power`, `energy_power`, `temperature`, `pressure`, `range`, `text`, `pushbutton` |
| `units` | Units (V, A, °C, kWh) |
| `error_value` | If raw == this, the control is published with an error |
| `unsupported_value` | If raw == this, the control is not published |
| `read_rate_limit_ms` | Do not poll more than once per N ms (for slow registers) |
| `enabled` | `false` — the channel is in the template but disabled by default |
| `readonly` | `true` — read-only even for `holding`/`coil` |
| `sporadic` | `true` — do not request on the first start |
| `condition` | Expression over `parameters` — the channel is visible only if true |
| `group` | Group ID for the UI |
| `word_order` | `big_endian` (default) or `little_endian` for multi-register |

### Endianness

Modbus bytes are big-endian, but the **word order** (of 16-bit registers) for u32/s32/float is often little-endian. Symptom: the value "jumps" — try `"word_order": "little_endian"`.

### `string` / `varstring`

```json
{"name": "FW Version", "reg_type": "input", "address": 250, "format": "string", "size": 8, "type": "text"}
```

`size` — length in registers (= 16 bytes). `varstring` — variable length with a null terminator.

## `parameters` — firmware settings

Registers that the UI shows as "device settings" (not telemetry):

```json
"parameters": [
  {
    "id": "in0_mode",
    "title": "Input 0 mode",
    "address": 1100,
    "reg_type": "holding",
    "format": "u16",
    "default": 0,
    "enum": [0, 1, 2, 3],
    "enum_titles": [{"en": "Switch"}, {"en": "Push button"}, {"en": "RS-trigger"}, {"en": "Counter"}],
    "group": "g_in0_setup"
  }
]
```

A channel's `condition` can reference a parameter by `id`: `"condition": "in0_mode==3"` — the channel is visible only if the parameter == 3.

## `groups` — grouping in the UI

```json
"groups": [
  {"id": "g_inputs", "title": "Inputs"},
  {"id": "g_in0_channels", "title": "Input 0", "group": "g_inputs"},
  {"id": "g_in0_setup", "title": "Input 0 setup", "group": "g_inputs"}
]
```

`group` references the parent `id`. The web UI renders collapsible sections.

## `translations` — i18n

```json
"translations": {
  "ru": {
    "Voltage": "Напряжение",
    "Input 0": "Вход 0",
    "g_inputs": "Входы"
  }
}
```

## Template creation workflow

1. **Device documentation** — `WebFetch` the manufacturer's manual (register table: addresses, types, scale). Do not make a template without it — guessing = endless debugging.

2. **Copy a similar packaged template as a starter**:

```bash
ssh root@<HOST> 'cp /usr/share/wb-mqtt-serial/templates/config-wb-mr6c.json /etc/wb-mqtt-serial.conf.d/templates/acme-em100.json'
```

At minimum: change `device_type`, `device.id`, `device.name`, `title`, then rewrite `channels` to match your register table.

3. **Test on a single channel**. First a template with **one** channel. Add the device to `/etc/wb-mqtt-serial.conf` via confed, verify publishing:

```bash
ssh root@<HOST> "mosquitto_sub -t '/devices/<device.id>_<slave_id>/controls/<channel>' -C 1 -W 5"
```

If the value is wrong — tweak `format`, `scale`, `word_order`. A direct reading via `modbus_client_rpc` (see `/wb-troubleshooting-serial`).

4. **Expand in batches of 5–10** channels, with a check via MQTT after each.

5. **Parameters and groups** — after the telemetry works.

6. **In git and in `/wb-controller-backup`** — a custom template does not survive FIT; the backup picks up `/etc/wb-mqtt-serial.conf.d/` on its own.

## Applying and logs

```bash
ssh root@<HOST> 'systemctl restart wb-mqtt-serial'
ssh root@<HOST> 'journalctl -u wb-mqtt-serial -n 50 --no-pager | grep -iE "(template|<device.id>)"'
```

Errors like `Failed to parse template` / `Unknown register type` — syntax.

## Example: 1-phase electricity meter

| Address | Reg | Format | Scale | What |
|---|---|---|---|---|
| 0–1 | input | u32 | 0.1 | Voltage (mV→V) |
| 2–3 | input | u32 | 0.001 | Current (mA→A) |
| 4–5 | input | s32 | 0.01 | Active power (W) |
| 6–7 | input | u32 | 0.001 | Active energy (Wh→kWh) |

```json
{
  "title": "ACME EM-100",
  "device_type": "ACME-EM100",
  "group": "g_energy_meters",
  "device": {
    "name": "ACME EM-100",
    "id": "acme-em100",
    "channels": [
      {"name": "Voltage", "reg_type": "input", "address": 0, "format": "u32", "scale": 0.1, "type": "voltage", "units": "V"},
      {"name": "Current", "reg_type": "input", "address": 2, "format": "u32", "scale": 0.001, "type": "current", "units": "A"},
      {"name": "Active Power", "reg_type": "input", "address": 4, "format": "s32", "scale": 0.01, "type": "power", "units": "W"},
      {"name": "Active Energy", "reg_type": "input", "address": 6, "format": "u32", "scale": 0.001, "type": "energy_power", "units": "kWh"}
    ]
  }
}
```

## Pitfalls

- **A template in `/usr/share/wb-mqtt-serial/templates/`** — will be overwritten on upgrade. Only `/etc/wb-mqtt-serial.conf.d/templates/`.
- **Endianness** — the most common error for u32/s32/float. The value jumps by a factor of 65535 — `word_order: little_endian`.
- **Scale in the wrong direction** — the manufacturer sometimes writes "raw / 10" instead of "raw × 0.1". Resolved by a test on a single channel.
- **Duplicate `device_type`** — if it matches a packaged one, it silently overrides. A prefix like `ACME-` helps.
- **Cyrillic in `device.id`** — forbidden (it ends up in the topic name). Only `[a-z0-9-]`.
- **0-based vs 1-based addresses** — the Modbus standard is 0-based, but many manuals write 1-based. Cross-check with the device spec.
- **Without `error_value`** — if the device returns FFFF for "no data", MQTT will show 65535 as a valid value.

## Documentation

- Template format: https://github.com/wirenboard/wb-mqtt-serial/blob/master/docs/template.md
- Modbus FC: https://modbus.org/docs/Modbus_Application_Protocol_V1_1b3.pdf
- Examples — `/usr/share/wb-mqtt-serial/templates/` on the controller (250+ templates).
