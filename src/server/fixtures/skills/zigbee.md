# zigbee

Zigbee devices on a Wiren Board controller. Load on "find zigbee", "what zigbee devices", "is there any zigbee", "zigbee2mqtt", "0x00158d", "pair a device", "add zigbee".

## How to identify a zigbee device

Devices with IEEE addresses like `0x00158d...`, `0x00124b...`, `0x04cd15...`, etc. are **Zigbee devices**. In MQTT they appear as `/devices/0x.../controls/...`. If the topic list contains `/devices/0x...` — the controller has Zigbee.

## Architecture

At the core is **zigbee2mqtt** (a separate project, not tied to WB releases). It talks to the Zigbee adapter and publishes data to its own topics `zigbee2mqtt/<friendly_name>`. Installed via the `apt install zigbee2mqtt` package or in Docker.

On top of zigbee2mqtt runs one of two **converters** that translate into WB MQTT Conventions (`/devices/.../controls/...`):

- **wb-mqtt-zigbee** (new, recommended, in the testing repository) — direct translation, controls work in both directions, management via the web interface without wb-rules. Devices appear as `/devices/zigbee_*`.
- **wb-zigbee2mqtt** (old) — creates virtual devices via wb-rules. WB-convention controls `/devices/<friendly_name>/controls/<control>` are **readonly** (you cannot write via `dev["name/control"] = value`). To control:
  ```js
  // wb-rules: controlling a zigbee device via wb-zigbee2mqtt
  publish("zigbee2mqtt/friendly_name/set", JSON.stringify({ state: "OFF" }), 2, false);
  ```

## Hardware module

The Zigbee adapter is the **WBE2R-R-ZIGBEE** extension module (v.2 is current). Configured in **wb-hardware.conf** (web UI: Settings → Extension modules and ports → select the slot → type "WBE2R-R-ZIGBEE"). The port depends on the slot: MOD1→`/dev/ttyMOD1`, MOD2→`/dev/ttyMOD2`, etc. This port is set in `serial.port` of the zigbee2mqtt config (`/mnt/data/root/zigbee2mqtt/data/configuration.yaml`).

The module **is not shown** on the Devices page — this is normal.

USB sticks are also supported (port `/dev/ttyUSBx`).

> **Installing zigbee2mqtt and the converter** — see the `software-install` skill (Zigbee2MQTT section).

## How to find devices

**MANDATORY order. Do not skip steps, do not substitute your own methods.**

**Do NOT use `mqtt_list_topics(prefix='zigbee2mqtt/#')` and `mqtt_list_topics(prefix='/devices/+/meta/name')` — the first will return megabytes, the second will find ALL devices, not just zigbee.**

### Step 1 — find controllers with zigbee2mqtt

For each online controller (can be done in parallel):
`mqtt_read(sn, "zigbee2mqtt/bridge/state")` — `"online"` = zigbee2mqtt is running.

If empty — check Docker: `ssh_exec(sn, "docker ps 2>/dev/null | grep -i zigbee")`. zigbee2mqtt often runs in Docker and publishes to the same MQTT broker.

**Result of step 1** — a list of SNs that have zigbee2mqtt. From here on, work only with them.

### Step 2 — are there any paired devices?

Check for the presence of the topic (without reading the contents — the JSON is huge!):
`mqtt_list_topics(sn, prefix="zigbee2mqtt/bridge/devices")` — if the topic exists, devices are paired.

### Step 3 — detailed list (only if the user asks)

`mqtt_read(sn, "zigbee2mqtt/bridge/devices")` — the full JSON with all devices. Filter `type != "Coordinator"` (that is the adapter, not a device).

For wb-mqtt-zigbee (testing): `mqtt_list_topics(sn, prefix="/devices/zigbee_")`.

## Z2M in Docker

An alternative to the `zigbee2mqtt` package is the official `koenkk/zigbee2mqtt` image. Useful when you need a fresh Z2M version before it lands in the repository, or if you want isolation.

A typical `/mnt/data/root/zigbee2mqtt/docker-compose.yml`:

```yaml
services:
  zigbee2mqtt:
    image: koenkk/zigbee2mqtt:latest
    container_name: zigbee2mqtt
    restart: unless-stopped
    network_mode: host             # to see mosquitto on localhost:1883
    volumes:
      - ./data:/app/data
      - /run/udev:/run/udev:ro
    devices:
      - /dev/ttyMOD1:/dev/ttyMOD1  # the port depends on the WBE2R slot
    environment:
      - TZ=Europe/Moscow
```

Start: `docker compose up -d` (NOT `docker-compose` — `docker compose` without the hyphen; the server blocks the deprecated syntax).

The config inside the container is mounted from `./data/configuration.yaml`:

```yaml
mqtt:
  base_topic: zigbee2mqtt
  server: mqtt://localhost:1883
serial:
  port: /dev/ttyMOD1
  adapter: ezsp                   # for WBE2R-R-ZIGBEE v.2; zstack/deconz for others
permit_join: false
homeassistant: false
frontend:
  port: 8080
```

Logs: `docker logs -f zigbee2mqtt | tail -100`. Reload config: `docker compose restart`.

**Pitfalls of the Docker variant:**
- Without `network_mode: host`, mosquitto on `localhost:1883` is not visible — use host or specify the controller's external IP.
- Without forwarding `/dev/ttyMODx` into `devices:`, the container does not see the USB stick/module.
- The WB converter config (`wb-mqtt-zigbee` / `wb-zigbee2mqtt`) is installed **on the host**, not in the container — it subscribes to `zigbee2mqtt/...` topics via the same mosquitto.
- On an image upgrade (`docker compose pull && docker compose up -d`) — the config and the device database in `./data/` are preserved.
- `docker ps` works without sudo on the controller, but you log in as root via SSH.

## Pairing

Via the controller's web interface: Devices tab → Zigbee2mqtt card → enable "Permit join" → hold the pair button on the device → wait for confirmation → turn off Permit join.

Via MQTT: `mqtt_publish(sn, "zigbee2mqtt/bridge/request/permit_join", '{"value": true}')`.

## Pitfalls

- `mqtt_list_topics(prefix='zigbee2mqtt/#')` — megabytes, do not do it.
- `mqtt_read("zigbee2mqtt/bridge/devices")` — a huge JSON. Parse it via `ssh_exec` + python3.
- `type: "Coordinator"` — that is the adapter, not a device. Filter it.
- zigbee2mqtt may be in Docker — `ssh_exec(sn, "docker ps 2>/dev/null | grep -i zigbee")`.
- The presence of the package ≠ the presence of devices.
- The WBE2R-R-ZIGBEE module is not visible on the Devices page — check via wb-hardware.conf.

## Documentation

- Zigbee on WB: <https://wiki.wirenboard.com/wiki/Zigbee>
- WBE2R-R-ZIGBEE v.2 module: <https://wiki.wirenboard.com/wiki/WBE2R-R-ZIGBEE_v.2_ZigBee_Extension_Module>
- wb-mqtt-zigbee: <https://github.com/wirenboard/wb-mqtt-zigbee>
