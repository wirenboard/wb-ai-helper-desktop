# troubleshooting-serial

Software diagnostics of the serial bus (RS-485, Modbus and other protocols) from the driver and MQTT level. Load this skill on: Modbus errors, CRC, timeouts, "device not responding", "data not updating", slow polling, read/write errors.

**IMPORTANT: Act without pauses. Do NOT ask permission for every step — the user has ALREADY asked for diagnostics, that IS the confirmation. Perform ALL steps in sequence: logs → debug → scan → health. Do NOT stop with questions like "do you want me to run debug?" or "if you want, I can..." — just do it. The report comes at the end. Save the log via `write_file(sn, "/mnt/data/ai/wb-ai-helper/diag/serial-diag.txt", <report>)`.**

## Start here

1. **Device documentation** — always show the source URL. Sequence:
   - `web_fetch("https://wirenboard.com/wiki/<DeviceModel>")` — device page, "Known issues" section
   - If you found nothing there — immediately try a wiki web search (the domain changed, try both): `web_search("site:wirenboard.com/wiki/ <DeviceModel> <error>")` or `web_search("site:wiki.wirenboard.com <DeviceModel> <error>")`
   - Check the device changelog (`web_fetch` the changelog page) — it often has ERRMODBUS codes and fixed bugs
   - **Always cite the URL** where you got the information
2. `systemctl is-active wb-mqtt-serial` — is the driver alive
3. Logs — scale and type:
```bash
ssh_exec(sn, "journalctl -u wb-mqtt-serial -p warning --since '1 hour ago' --no-pager | grep -c 'failed to'; journalctl -u wb-mqtt-serial -p warning --since '1 hour ago' --no-pager | grep -oP 'device modbus:\\K\\d+' | sort | uniq -c | sort -rn; journalctl -u wb-mqtt-serial -p warning -n 15 --no-pager")
```
4. **Debug — raw packets. RUN IT IMMEDIATELY, WITHOUT ASKING.** This is a safe operation — `serial_debug_collect` enables and disables debug itself, and restarts the driver itself. Call the tool immediately after analyzing the logs.

Debug duration: divide 18000 by the number of errors per hour (from step 3). The result is in seconds. Minimum 30, maximum 300. If there are 0 errors — use 120.

Table:
- 10 errors/hour → 18000/10 = 1800 → cap 300 sec
- 50 errors/hour → 18000/50 = 360 → cap 300 sec
- 100 errors/hour → 18000/100 = 180 sec
- 500 errors/hour → 18000/500 = 36 sec
- 1000 errors/hour → 18000/1000 = 18 → floor 30 sec

Call it right now: `serial_debug_collect(sn, durationSec)`. Do NOT write "if you want, I'll run debug" — JUST CALL THE TOOL.

After it finishes, retrieve the log: `fetch_from_controller(sn, "/mnt/data/ai/wb-ai-helper/diag/debug-serial.log")`.

If the error didn't reproduce within 2 minutes — tell the user: the problem is rare, debug is off.

5. **Bus scan** — who is present, who is missing, duplicates. **Use the parameters from step 3 (ports/Load).** Call the `wb_bus_scan` tool — it starts the scan itself, polls the progress, and delivers the result via a banner:
```
wb_bus_scan(sn, port="/dev/ttyRS485-1", baud_rate=115200, parity="N", stop_bits=2)
```
Substitute the real port parameters! Do NOT call mqtt_rpc for a bus scan directly — use only `wb_bus_scan`. The scan finds only WB and Onokom (Fast Modbus). Third-party devices — only via `modbus_client_rpc`.

6. **Health of WB devices** — power and uptime (only for WB, determined by the scan):
```bash
ssh_exec(sn, "modbus_client_rpc -m rtu -a <slave> -t 3 -r 104 -c 2 -b <baud> -s <stop> -p <parity> <path> && modbus_client_rpc -m rtu -a <slave> -t 3 -r 121 -c 2 -b <baud> -s <stop> -p <parity> <path>")
```

## Device firmware version

If you need the firmware version of a specific WB device — **don't ask the user**, do this:

1. Load the driver config: `mqtt_rpc(sn, "wb-mqtt-serial", "config", "Load", {})`
2. Find the device by slave_id, note its `device_type` (for example `WB-MDM3`)
3. Load the template for this type: `mqtt_rpc(sn, "wb-mqtt-serial", "templates", "GetTemplate", {"device_type": "<device_type>"})`
4. Among the template channels, find the one whose name resembles a firmware version: `FW Version`, `Firmware Version`, `SW Version`, `Serial`, etc. — the name can be anything, search by meaning
5. In the driver config, find this channel on the relevant device and enable it: `"enabled": true`
6. Save the config: `mqtt_rpc({ sn, driver:"confed", service:"Editor", method:"Save", params:{ path:"/etc/wb-mqtt-serial.conf", content:"<full config>" } })`
7. Read the value from MQTT: `mqtt_get(sn, "/devices/<device_id>/controls/<channel_name>")`

Example: on `wb-mdm3_57` the channel is called `FW Version`, on another device it may be different — always check the template.

## Patterns: saw → do

| Saw | Do |
|---|---|
| `invalid crc` in logs | Debug → look at the raw packet. Broken CRC = interference/contact. Foreign slave_id = duplicate |
| `request timed out` | `device/Probe` → is it alive. If silent — physics, power, slave_id |
| `invalid data size` | Scan → look for a duplicate slave_id. Debug → extra bytes = collision |
| `rate limit exceeded` | Spread devices across ports, increase baud, disable unused channels |
| Device in scan but not in config | May interfere! Add it or disconnect physically |
| Device in config but not in scan | Disabled, broken link, or third-party (scan doesn't see it) |
| CRC on all devices | Interference, 120 Ohm terminator, grounding. Experiment: lower the speed |
| CRC on one device | Connect with a short wire. If it works — the line is the issue |
| Different stop bits help | Mismatch between port and device parameters |
| Min. voltage < 20V (reg. 122) | Power sags → power supply, wire cross-section |
| Small uptime (reg. 104-105) | Device rebooted → power |
| Exception code in debug | 1=illegal FC, 2=illegal addr, 3=illegal value, 4=device failure |
| Protocol is not Modbus in the config | modbus_client_rpc and scan won't help, only logs and debug |

## Tools

**modbus_client_rpc** (priority) — through the driver queue, safe:
```bash
modbus_client_rpc -m rtu -a <slave> -t <FC> -r <reg> -c <count> -b <baud> -s <stop> -p <parity> <port>
```
FC: 1=coils, 2=discrete, 3=holding, 4=input, 5=write coil, 6=write reg, 15=write coils, 16=write regs.

**device/Probe** — quick "is it alive" check:
```
mqtt_rpc(sn, "wb-mqtt-serial", "device", "Probe", {"path":"..","baud_rate":..,"data_bits":..,"parity":"..","stop_bits":..,"slave_id":..,"total_timeout":10000})
```

**ports/Load** — port parameters:
```
mqtt_rpc(sn, "wb-mqtt-serial", "ports", "Load", {})
```

**wb-modbus-scanner** — Fast Modbus utility (WB, Onokom). `apt install wb-modbus-ext-scanner`. Conflicts with the driver — HITL.
```bash
wb-modbus-scanner -d <port> -b <baud>        # scan
wb-modbus-scanner -d <port> -s <sn> -i <id>  # change slave_id
```

**modbus_client** — direct access. Conflicts with the driver — HITL.

## Useful registers of WB devices

| Register | What | Format |
|---|---|---|
| 104-105 | Uptime | u32, seconds |
| 110 | Baud rate | u16, abbreviated: 96=9600, 1152=115200 |
| 121 | Supply voltage | u16, mV |
| 122 | Min. voltage | u16, mV (since boot) |
| 128 | Slave ID | u16 |
| 200-205 | Model | string |
| 270-271 | Serial number | u32 |

Broadcast write (slave_id 0) — change baud/address for all WB devices on the bus at once.

baud_rate `1152` = `115200` — abbreviated notation, NOT an error.

## Experiments (backup + HITL)

Before experiments: `ssh_exec(sn, "cp /etc/wb-mqtt-serial.conf /etc/wb-mqtt-serial.conf.bak-$(date +%s)")`

- **Stop bits**: try 1 and 2 via `modbus_client_rpc -s 1` / `-s 2`
- **Speed**: broadcast `modbus_client_rpc -a 0 -t 6 -r 110 ... 96` → change the port via confed. Errors gone = cable/termination
- **Isolation**: `config/Load` → `"enabled": false` → `confed/Editor/Save`. Errors on the rest gone = this device is the one interfering
- **Timeouts**: `response_timeout_ms`, `guard_interval_us` in the port config

**Revert everything after the experiments.**

## Pitfalls

- `modbus_client`/`wb-modbus-scanner` without stopping the driver → false errors
- Debug forgotten → disk fills up
- port/Scan → only WB and Onokom
- Wrong baud → COMPLETELY silent. Wrong stop bits → floating errors
- RS-485 in a star topology works at short distances; on problems — recommend a daisy chain

## Documentation

- <https://wiki.wirenboard.com/wiki/RS-485>
- <https://wiki.wirenboard.com/wiki/Modbus>
- <https://wiki.wirenboard.com/wiki/Common_Modbus_Registers>
- <https://wiki.wirenboard.com/wiki/How_to_diagnose>
- <https://github.com/wirenboard/wb-modbus-ext-scanner/blob/main/docs/protocol.ru.md>
