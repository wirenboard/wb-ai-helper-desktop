# wb-mqtt-serial-template

Creating a custom JSON device template for wb-mqtt-serial when the device is not found in the controller's built-in templates. Load on: "add a device from documentation", "the device is not in the templates", "build a template for a Modbus device", "no template for X", "write a register description", "create a template for wb-mqtt-serial", "registers from the datasheet".

**Boundary:** if the template already exists and you need to enable/disable channels or add the device to the config — that's the `wb-mqtt-serial` skill. This skill is only for creating a new template from scratch.

## Main path

1. **First look for a built-in template** — don't guess, check on the controller:
   ```
   ssh_exec(sn, "ls /usr/share/wb-mqtt-serial/templates/ | grep -i <name>")
   ```
   If not found — `web_search` by model name + "wb-mqtt-serial template".

2. **Request the datasheet** from the user. You need: function codes (FC01–FC04), register addresses, data type, scale, byte order.

3. **Probe the registers before writing the template** via `modbus_client_rpc` — make sure the addresses exist and the values are reasonable. Do this with a live device on the bus:
   ```
   ssh_exec(sn, "modbus_client_rpc -m rtu -a <slave_id> -t 3 -r <address> -c <count> -b <baud> -s <stop> -p <parity> <port>")
   ```
   FC: `1`=coils, `2`=discrete, `3`=holding, `4`=input. Check the scale right away — raw / scale should give the expected value.

4. **Build the JSON** using the structure below.

5. **Write the template to the controller:**
   ```
   write_file(sn, "/etc/wb-mqtt-serial.conf.d/templates/my-device.json", "<json>")
   ```

6. **Verify the template was picked up via RPC:**
   ```
   mqtt_rpc({ sn, driver:"wb-mqtt-serial", service:"device", method:"LoadConfig",
     params: { path:"/dev/ttyRS485-1", baud_rate:9600, parity:"N",
               data_bits:8, stop_bits:2, slave_id:1, device_type:"my-device" }
   })
   ```

7. **Add the device to the config** via `confed/Editor/Save` — see the `wb-mqtt-serial` skill.

## Template structure

```json
{
  "device_type": "my-device",
  "device": {
    "name": "Vendor Model",
    "id": "my-device",
    "max_reg_hole": 10,
    "max_read_registers": 60,
    "guard_interval_us": 1000,
    "channels": []
  }
}
```

- `device_type` — used in `wb-mqtt-serial.conf` as `"device_type": "my-device"`
- `id` — MQTT topic prefix: `/devices/my-device_<slave_id>/...`
- `max_reg_hole` — allowed gap in addresses when grouping requests (0 = disabled)
- `guard_interval_us` — pause between requests in µs (increase for slow devices)

## Channel fields

```jsonc
{
  "name": "Temperature",      // Name in the UI and MQTT
  "reg_type": "holding",      // coil | discrete | holding | input
  "address": 100,             // Register address (decimal, 0-based)
  "type": "temperature",      // Widget type (see below)
  "format": "s16",            // u16 | s16 | u32 | s32 | float | double
  "scale": 0.1,               // value = raw * scale + offset
  "offset": 0,
  "units": "°C",             // For type:"value" — physical unit
  "readonly": true,
  "enabled": true,            // false — channel hidden, not polled by default
  "poll_interval": 10000,     // ms between polls
  "word_order": "big_endian", // For 32-bit: big_endian | little_endian
  "max": 100, "min": 0       // For type:"range"
}
```

Widget types: `value`, `switch`, `alarm`, `pushbutton`, `range`, `text`,
`temperature`, `rel_humidity`, `atmospheric_pressure`, `voltage`, `current`,
`power`, `power_consumption`, `energy`, `lux`, `concentration`, `wind_speed`.

## FC → reg_type

| FC (datasheet) | reg_type | Access |
|---|---|---|
| FC01 | coil | R/W, 1 bit |
| FC02 | discrete | RO, 1 bit |
| FC03 | holding | R/W, 16-bit |
| FC04 | input | RO, 16-bit |

## Typical snippets

```jsonc
// Discrete input (FC02)
{ "name": "DI 1", "reg_type": "discrete", "address": 0, "type": "switch", "readonly": true }

// Relay (FC01)
{ "name": "DO 1", "reg_type": "coil", "address": 0, "type": "switch" }

// Temperature 0.1°C, signed (FC03)
{ "name": "Temperature", "reg_type": "holding", "address": 0,
  "type": "temperature", "format": "s16", "scale": 0.1, "readonly": true }

// Voltage, uint16, scale 0.01 (FC03)
{ "name": "Voltage", "reg_type": "holding", "address": 10,
  "type": "voltage", "format": "u16", "scale": 0.01, "readonly": true }

// 32-bit counter, little-endian (FC03)
{ "name": "Counter", "reg_type": "holding", "address": 100,
  "type": "value", "format": "u32", "word_order": "little_endian", "readonly": true }

// Writable setpoint (FC03)
{ "name": "Threshold", "reg_type": "holding", "address": 200,
  "type": "range", "format": "s16", "min": 0, "max": 1000 }
```

## Template debugging

**Validation errors** — after `LoadConfig` or in the journal:
```
ssh_exec(sn, "journalctl -u wb-mqtt-serial -n 100 --no-pager | grep -iE 'error|invalid|template|schema'")
```
Typical error texts:
- `Missing required property 'input_N_mode'` — the template did not describe the device's required parameters; you need a `setup[]` block with defaults or a complete description from the built-in template
- `Unknown device type` — the `device_type` in the template does not match the one in the config; check the spelling
- `Invalid address` — address out of the 0–65535 range or not an integer

**Value reads but is incorrect** — check the raw value via `modbus_client_rpc` and recompute scale/offset by hand. If the raw value is nonsense — it's most likely `word_order`: swap `big_endian` ↔ `little_endian`.

**Device doesn't respond at all** (timeout, CRC) — this is not a template problem, it's RS-485/physics. Load the `troubleshooting-serial` skill.

## Pitfalls

- **Addresses are 1-based in the datasheet**: `40001` = holding register 0, `10001` = discrete 0. Always subtract 1.
- **Byte order**: default is `big_endian`. If 32-bit values are nonsense — `"word_order": "little_endian"`.
- `format` is not needed for `coil`/`discrete` — they are always 1 bit.
- `max_reg_hole: 0` with scattered addresses → every channel is a separate request → slow polling.
- A custom template only belongs in `/etc/wb-mqtt-serial.conf.d/templates/` — in `/usr/share/...` it will be overwritten by an update.
- After `write_file` of the **template file** (`/etc/wb-mqtt-serial.conf.d/templates/*.json`) no restart is needed — the template is picked up on the next `LoadConfig`. But `write_file` of the main config (`wb-mqtt-serial.conf`) requires a restart — do it via `confed/Editor/Save`.
- If there are several devices on the port — validation requires full parameters (a wb-mqtt-serial bug): take them from the built-in template via `device/LoadConfig` for a similar device.
- Didn't check the registers with `modbus_client_rpc` before writing the template → you'll waste time on non-existent addresses.

## Documentation

- Template format: <https://github.com/wirenboard/wb-mqtt-serial/blob/main/README.md>
- Template examples: <https://github.com/wirenboard/wb-mqtt-serial/tree/main/templates>
- Wiki: <https://wirenboard.com/wiki/wb-mqtt-serial>
