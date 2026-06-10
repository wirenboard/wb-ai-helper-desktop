# hardware-modules

Configuring internal expansion modules and ports of a Wiren Board controller. Load this when the user asks to configure, connect, or check: an expansion module (MOD1-MOD4), WBIO (discrete I/O), a Zigbee module, CAN, RS-232/RS-485, GPS, KNX, eBUS, OpenTherm, HDMI, analog inputs. Also if they ask about slots, ttyMOD, wb-hardware.conf, expansion modules, or "which module is in which slot".

## Architecture

- **Configuration:** `/etc/wb-hardware.conf` — a JSON file describing which module is in which slot.
- **Service:** `wb-hwconf-manager` — reads the config and applies Device Tree overlays through the kernel. It has no direct MQTT/RPC.
- **Editing:** via the `get_hardware_config` / `save_hardware_config` tools (wrappers over confed/Editor RPC).
- **Web interface:** Settings → Expansion modules and ports.

## Controller slots

| Slot | Port | Purpose |
|------|------|------|
| mod1–mod4 | `/dev/ttyMOD1`–`/dev/ttyMOD4` | Expansion modules (Zigbee, CAN, RS-232, RS-485, GPS, KNX, eBUS, OpenTherm, HDMI, analog inputs, etc.) |
| extio1–extio8 | GPIO | WBIO discrete I/O modules (relays, dry contacts, SSR) |
| rs485-1, rs485-2 | `/dev/ttyRS485-1`, `/dev/ttyRS485-2` | Built-in RS-485 ports (terminator setting) |
| w1, w2 | 1-Wire | 1-Wire buses |
| wbc | — | Modem (2G/3G/4G/NB-IoT) |

## Tools

**Always use these tools — do not call mqtt_rpc(confed/Editor/Load) or mqtt_rpc(confed/Editor/Save) directly!**

```
get_hardware_config(sn=SN)
// Response: { configPath, content (config object), schema (JSON Schema with all modules and options) }
```

```
save_hardware_config(sn=SN, slot_id="mod1", module="wbe2-r-zigbee")
save_hardware_config(sn=SN, slot_id="mod1", module="wbe2-r-zigbee", options={...})
save_hardware_config(sn=SN, slot_id="mod1", module="")   // remove the module
```

`save_hardware_config` itself loads the current config, changes the needed slot, and saves it — you don't need to pass `content`.

**What happens on save_hardware_config:**
1. Confed validates the JSON against the schema
2. Converts it to a simplified format and writes `/etc/wb-hardware.conf`
3. Restarts `wb-hwconf-manager`
4. wb-hwconf-manager applies/removes Device Tree overlays
5. Restarts dependent services (wb-mqtt-gpio for WBIO, etc.)

**This is a safe operation** — if the JSON is invalid, Save returns an error and writes nothing.

## Scenario: view the current module configuration

1. `get_hardware_config(sn=SN)`
2. From `content` — show the user a table: slot → module → options.
3. From `schema` → `oneOf` — you can show which modules are available for each slot.

## Scenario: install a module into a slot

**Step 0 — ask the user which slot the module is physically inserted into.**
Don't pick the slot yourself. The user knows where they inserted the module. Ask explicitly:
> "Which slot is the module physically inserted into? (mod1, mod2, mod3, or mod4)"

Only after the answer proceed to step 1.

Example — install Zigbee into mod1:
```
// Step 1: find out the available modules and the current config
result = get_hardware_config(sn=SN)
// result.schema — list of compatible modules for each slot

// Step 2: save in a single call
save_hardware_config(sn=SN, slot_id="mod1", module="wbe2-r-zigbee")
```

1. `get_hardware_config(sn=SN)` — look at the current config and available modules.
2. From `schema`, determine the correct `module` value for the needed module type. Typical values:

| Module | `module` value |
|--------|-------------------|
| Zigbee (WBE2R-R-ZIGBEE) | `wbe2-i-zigbee` |
| CAN | `wbe2-i-can` |
| RS-232 | `wbe2-i-rs232` |
| RS-485 | `wbe2-i-rs485` |
| GPS | `wbe2-i-gps` |
| KNX | `wbe2-i-knx` |
| eBUS | `wbe2-i-ebus` |
| OpenTherm | `wbe2-i-opentherm` |
| HDMI | `wbe2-hdmi` |
| Analog inputs | `wbe2-i-analog` |
| Empty (remove the module) | `""` |

> **Important:** The exact module identifiers may differ across controller revisions. Always take `module` from the `schema`, not from this table.

4. Show the user exactly what is changing (was → now).
5. After confirmation — `save_hardware_config(sn=SN, slot_id=<slot id>, module=<module from schema>)`.
6. Check that the port appeared:
```bash
ssh_exec(sn, "ls -la /dev/ttyMOD3")  # for mod3
```

## Scenario: configure a WBIO module

WBIO modules (discrete I/O) plug into slots `extio1`–`extio8`. Typical modules:
- `WBIO-DI-DR-16` — 16 dry-contact inputs
- `WBIO-DO-R10R-4` — 4 relay outputs, 10 A
- `WBIO-DO-SSR-8` — 8 SSR outputs
- `WBIO-AI-DV-12` — 12 analog inputs
- `WBIO-DO-OC-12` — 12 open-collector outputs

1. `get_hardware_config(sn=SN)`
2. Find the `extioN` slot — `schema` will list the available WBIO modules.
3. Set `module` (for example `"wbio-di-dr-16"`) — take the exact value from the schema.
4. `save_hardware_config(sn=SN, slot_id=<extioN>, module=<module from schema>)`
5. After saving, wb-mqtt-gpio will restart and create the `/devices/wb-gpio/...` devices.
6. Check:
```bash
ssh_exec(sn, "systemctl is-active wb-mqtt-gpio")
```
```jsonc
mqtt_list_topics({ sn, prefix: "/devices/wb-gpio/controls" })
```

## Scenario: configure an RS-485 port

Built-in RS-485 ports (`rs485-1`, `rs485-2`) — terminator setting:

1. `get_hardware_config(sn=SN)`
2. Find the `rs485-1` or `rs485-2` slot in `content`.
3. In `schema`, look at the allowed `options.terminator` values for that slot.
4. `save_hardware_config(sn=SN, slot_id="rs485-1", module=<current module>, options={terminator: "on"})`

## Pitfalls

- **Don't call mqtt_rpc(confed/Editor/Load or Save) directly** — use `get_hardware_config` / `save_hardware_config`. Without params.path confed returns an error.
- **Don't edit `/etc/wb-hardware.conf` via write_file or ssh_exec** — only via `save_hardware_config`. Direct writing bypasses confed validation and won't apply the overlays.
- **If save_hardware_config returned an error** — report it to the user, don't try to work around it via ssh_exec or write_file.
- **Module identifiers** (`module`) depend on the board revision. Always take them from the `schema` returned by `get_hardware_config`.
- **The Zigbee module is not visible on the Devices page** — this is normal. The Zigbee adapter is not a Modbus device. Check via wb-hardware.conf.
- **After installing a module into a slot**, you need to configure the software: Zigbee → zigbee2mqtt (the `software-install` skill), CAN → wb-mqtt-can, and so on.
- **WBIO modules** — they physically connect to the connector on the controller board; the wb-hardware.conf configuration assigns the slot.
- **Changing the module in a slot** — the old module is deinitialized (the overlay is removed), the new one is initialized. It's safe, but the old module's devices will disappear.

## Documentation

- Expansion modules: <https://wiki.wirenboard.com/wiki/Internal_modules>
- wb-hwconf-manager: <https://github.com/wirenboard/wb-hwconf-manager>
- WBIO: <https://wiki.wirenboard.com/wiki/WBIO>
- WBE2R-R-ZIGBEE: <https://wiki.wirenboard.com/wiki/WBE2R-R-ZIGBEE_v.2_ZigBee_Extension_Module>
