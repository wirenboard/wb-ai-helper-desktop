# wb-scenarios

`wb-scenarios` is a separate engine on top of `wb-rules` that generates JS rules from declarative JSON in `/etc/wb-scenarios.conf`. It is a "no-code" layer for common tasks: group device control, light by motion, thermostat, schedule.

Load on: "make a scenario", "set up a thermostat", "light by motion sensor", "turn off on schedule", `wb-scenarios.conf`, "scenarios in the web UI".

**Boundary:** full JS with complex logic — `wb-rules` (defineRule, ES5). Scenarios are a simplified layer for typical cases. If the task is non-standard or requires computation — go to wb-rules.

## Architecture

```
/etc/wb-scenarios.conf   (via confed, JSON)
       │
       ▼
wb-scenarios-reloader.service
       │ (generates .js under the hood)
       ▼
/etc/wb-rules/<generated rules>
       │
       ▼
wb-rules engine
```

Service: `wb-scenarios-reloader` (NOT `wb-scenarios.service` — that one does not exist).

Schema: `/usr/share/wb-mqtt-confed/schemas/wb-scenarios.schema.json` — describes the 4 scenario types and the UI.

## Four scenario types

### 1. `devicesControl` — group control

"When control A changes → set controls B and C". Basic automation.

```json
{
  "scenarioType": "devicesControl",
  "name": "Hallway light",
  "id_prefix": "corridor_light",
  "enable": true,
  "inControls": [
    {"deviceId": "wb-mwac_25", "controlId": "Input 1"}
  ],
  "outControls": [
    {"deviceId": "wb-mr6c_2", "controlId": "K1", "value": true}
  ]
}
```

`inControls` — triggers (value change), `outControls` — what to set and with what value.

### 2. `lightControl` — light

Turn on by motion sensor with an off-timer, night mode, dimming.

```json
{
  "scenarioType": "lightControl",
  "name": "Bathroom light",
  "id_prefix": "wc_light",
  "enable": true,
  "motionSensor": {"deviceId": "wb-msw-v4_20", "controlId": "Motion"},
  "lightOutput": {"deviceId": "wb-mr6c_2", "controlId": "K2"},
  "delayOff": 60,
  "ambientLightSensor": {"deviceId": "wb-msw-v4_20", "controlId": "Illuminance"},
  "darkThreshold": 100
}
```

### 3. `thermostat` — thermostat

Turn on the heater based on the setpoint−current difference with hysteresis.

```json
{
  "scenarioType": "thermostat",
  "name": "Living room",
  "id_prefix": "living_room",
  "enable": true,
  "temperatureSensor": {"deviceId": "wb-msw-v4_20", "controlId": "Temperature"},
  "heaterOutput": {"deviceId": "wb-mr6c_2", "controlId": "K3"},
  "setpoint": 22.0,
  "hysteresis": 0.5
}
```

### 4. `schedule` — schedule

"Every day at HH:MM do X". Under the hood — wb-rules cron.

```json
{
  "scenarioType": "schedule",
  "name": "Irrigation",
  "id_prefix": "watering",
  "enable": true,
  "schedule": {"hour": 6, "minute": 30, "days": [1,2,3,4,5,6,7]},
  "actions": [
    {"deviceId": "wb-mr6c_2", "controlId": "K4", "value": true},
    {"deviceId": "wb-mr6c_2", "controlId": "K4", "value": false, "delay": 1800}
  ]
}
```

`days` — `[1..7]` (1=Mon … 7=Sun). `delay` — delay after the previous action (sec).

## Basic commands

```bash
ssh root@<HOST> 'cat /etc/wb-scenarios.conf'                                # current
ssh root@<HOST> 'systemctl status wb-scenarios-reloader --no-pager'         # status
ssh root@<HOST> 'journalctl -u wb-scenarios-reloader -n 30 --no-pager'      # logs
ssh root@<HOST> 'ls /etc/wb-rules/wb-scenario-*.js 2>/dev/null'             # generated .js
```

After editing the config, `wb-scenarios-reloader` regenerates the rules and restarts `wb-rules`. Via `mqtt_rpc confed/Editor/Save` (see `wb-mqtt-serial` — the shared confed pattern is there) the restart is automatic; via `write_file` you need to run `systemctl restart wb-scenarios-reloader` manually.

## When a scenario is not enough — go to wb-rules

- The condition depends on several controls at once with logic.
- A computed value is needed (average, asymmetric hysteresis, PID).
- State is needed (counters, "N times in a row" trigger).
- Timers other than schedule are needed (interval, exponential delay).
- Virtual devices.

Scenarios are good for "pressed a button → turned on a relay" and "turned on/off by timer". Beyond that — wb-rules.

## Pitfalls

- **`wb-scenarios.service` does not exist** — the service is called `wb-scenarios-reloader`.
- **Duplicate `id_prefix`** — two scenarios with the same `id_prefix` will generate overlapping rule names, causing a conflict.
- **Editing `/etc/wb-rules/wb-scenario-*.js` directly** — it is overwritten on the next reload. Only via `wb-scenarios.conf`.
- **Cyrillic in `id_prefix`** — forbidden by the schema (regex `^[0-9a-zA-Z_]+$`). In `name` it is allowed.
- **Scenario did not appear in the web UI** — check `journalctl -u wb-scenarios-reloader` for parse errors. A broken config means the UI shows nothing.
- **A scenario and an analogous wb-rules rule** — conflict (both write to the same control). Do not duplicate.
- **`schedule` without a timezone** — uses the system one (`timedatectl`). After a tz upgrade, scenarios may "shift".

## Documentation

- WB wiki — scenarios: https://wirenboard.com/wiki/Wb-scenarios
- Schema: `/usr/share/wb-mqtt-confed/schemas/wb-scenarios.schema.json` on the controller.
