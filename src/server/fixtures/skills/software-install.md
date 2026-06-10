# software-install

Installing third-party and additional software on a Wiren Board controller. Load this when the user asks to install, configure, or integrate: Docker, Node-RED, Home Assistant, Zigbee2MQTT, Mosquitto, InfluxDB, Grafana, a Telegram bot, or any other third-party software. Also if they ask about integration with external systems or connecting devices.

## Before installing

1. **Check the documentation.** Many popular packages have WB-specific installation details. First `web_fetch` the wiki:
   - Docker: `web_fetch('https://wiki.wirenboard.com/wiki/Docker')`
   - Home Assistant: `web_fetch('https://wiki.wirenboard.com/wiki/Home_Assistant')`
   - Compatible software and devices: `web_fetch('https://wiki.wirenboard.com/wiki/Supported_devices')`
   - General search: `web_fetch('https://wirenboard.com/wiki/Special:Search?search=<query>')`
2. **Check the disk space** — `df -h / /mnt/data`. The rootfs on WB is only 2 GB, store data in `/mnt/data`.
3. **Check what's already installed** — `dpkg -l | grep <package>`, `systemctl is-active <service>`.
4. **Take a snapshot** — `save_state_for_diff(sn)` before installing. After installing — `diff_snapshot(sn, path)` to show what changed (new packages, services, files).

## WB specifics

### Docker

**Do NOT install via `apt install docker.io` or `apt install docker-ce` directly** — the rootfs (2 GB) will overflow. The ONLY correct way is the `wb-docker-manager.sh` script:

```bash
ssh_exec_async(sn, "wget -O /tmp/wb-docker-manager.sh https://raw.githubusercontent.com/wirenboard/wb-community/refs/heads/main/scripts/docker-install/wb-docker-manager.sh && bash /tmp/wb-docker-manager.sh --install", label="install docker")
```

**What the script does (do NOT repeat manually — just run the script above):**
1. Installs dependencies: `ca-certificates curl gnupg lsb-release iptables`
2. Adds the official Docker repository (GPG key + sources.list) — the `docker-ce` package, NOT `docker.io`
3. Switches iptables to the legacy version (needed for Docker on WB)
4. Creates directories and symlinks for storing data on `/mnt/data/`:
   - `/mnt/data/etc/docker` → `/etc/docker` (config)
   - `/mnt/data/var/lib/containerd` → `/var/lib/containerd`
   - `/mnt/data/.docker` — image storage (`data-root` in daemon.json)
5. Configures the log limit: 10 MB × 3 files
6. Installs `docker-ce docker-ce-cli containerd.io`
7. Enables autostart and verifies `hello-world`

**After installing, check:**
```
ssh_exec(sn, "docker --version && docker info --format '{{.DockerRootDir}}' && df -h /mnt/data")
```
The Docker root should be `/mnt/data/.docker`. Expected contents of `/etc/docker/daemon.json`:
```json
{
  "data-root": "/mnt/data/.docker",
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" }
}
```

Docker Compose files are usually placed in `/mnt/data/<project>/`.

Documentation: <https://wiki.wirenboard.com/wiki/Docker>.

### Home Assistant

Installed via Docker. Instructions: <https://wiki.wirenboard.com/wiki/Home_Assistant>.

### Zigbee2MQTT

Full installation flow:

1. **Check the hardware module** — load the module configuration:
```
get_hardware_config(sn=SN)
```
Look in `content` for slots `mod1`–`mod4` with `module` containing `zigbee`.

   - **Module found** → remember the slot number and port (e.g. `mod3` → **ZIGBEE_PORT=`/dev/ttyMOD3`**). Go to step 2.
   - **Module NOT found** → ask the user: "Which slot (MOD1–MOD4) is the Zigbee module WBE2R-R-ZIGBEE installed in?" or "Is the module not installed yet?". If the user specified a slot — configure the module:
```
// In content find the right slot by id (e.g. "mod3") and set module:
// slot.module = "wbe2-i-zigbee"  (take the exact value from schema.oneOf!)
save_hardware_config(sn=SN, content=<modified content>)
```
After saving, check that the port appeared: `ssh_exec(sn, "ls -la /dev/ttyMOD<N>")`.
Remember the port: **ZIGBEE_PORT=`/dev/ttyMOD<N>`** (where N is the slot number).
If it's a USB stick — **ZIGBEE_PORT=`/dev/ttyUSBx`**, configuring wb-hardware.conf is not needed.

> More about configuring modules — the `hardware-modules` skill.

2. **Check for wb-mqtt-zigbee** (the recommended converter for UI integration):
```bash
ssh_exec(sn, "apt-cache show wb-mqtt-zigbee 2>/dev/null | head -5")
```

3. **Install zigbee2mqtt**:
   - If wb-mqtt-zigbee is available — install **without Recommends** (otherwise it will pull in the old wb-zigbee2mqtt):
```bash
ssh_exec_async(sn, "apt-get update && apt-get -y --no-install-recommends install zigbee2mqtt && apt-get -y install wb-mqtt-zigbee", label="install zigbee2mqtt")
```
   - If wb-mqtt-zigbee is unavailable — install normally (it will pull in wb-zigbee2mqtt as a Recommends):
```bash
ssh_exec_async(sn, "apt-get update && apt-get -y install zigbee2mqtt", label="install zigbee2mqtt")
```

4. **Configure the zigbee2mqtt port** — write **ZIGBEE_PORT** (determined in step 1) into the config's `serial.port`:
```bash
ssh_exec(sn, "sed -i 's|port:.*|port: /dev/ttyMOD<N>|' /mnt/data/root/zigbee2mqtt/data/configuration.yaml")
```
Substitute the actual port from step 1 in place of `/dev/ttyMOD<N>`.

5. **Start it and enable autostart**:
```bash
ssh_exec(sn, "systemctl enable --now zigbee2mqtt && systemctl is-active zigbee2mqtt")
```

6. **Verify**:
```bash
ssh_exec(sn, "systemctl is-active zigbee2mqtt && mosquitto_sub -t 'zigbee2mqtt/bridge/state' -C 1 -W 5")
```

> **Searching for and managing devices** — see the `zigbee` skill.

Documentation: <https://wiki.wirenboard.com/wiki/Zigbee>, <https://wiki.wirenboard.com/wiki/WBE2R-R-ZIGBEE_v.2_ZigBee_Extension_Module>.

### Node-RED

Installed via Docker. Data in `/mnt/data/node-red/`.

## General rules

- Installing packages — via `ssh_exec_async` (a long operation): `apt-get -y install <package>`. The server will add `DEBIAN_FRONTEND=noninteractive` automatically.
- Third-party software's data — always in `/mnt/data/`, not in the rootfs. Create symlinks if a service wants to write to `/var/lib/`.
- After installing, check: `systemctl is-active <service>`, `journalctl -u <service> -n 20`.
- If the user asks about integrating an unfamiliar device — first `web_fetch('https://wiki.wirenboard.com/wiki/Supported_devices')` and search there.

## If Docker doesn't start after installation

**First of all, check for a kernel mismatch:** `uname -r` vs `dpkg -l linux-image-wb*`. If the versions don't match — the controller is running on an old kernel after an update. Kernel modules (br_netfilter, iptable_nat, etc.) won't load, Docker/iptables won't work. The solution is a reboot, not workarounds.

**iptables / MASQUERADE / DOCKER-ISOLATION-STAGE error.** If in `journalctl -u docker` you see:
```
error creating default "bridge" network: Failed to Setup IP tables: Unable to enable NAT rule:
Chain 'MASQUERADE' does not exist
```
or similar errors about iptables/nf_tables — it means Docker can't set up the virtual networks. The solution from the wiki:

1. Switch iptables to the legacy version (the `wb-docker-manager.sh` script does this itself, but if it was installed manually — it may have been skipped):
```bash
ssh_exec(sn, "update-alternatives --set iptables /usr/sbin/iptables-legacy && update-alternatives --set ip6tables /usr/sbin/ip6tables-legacy")
```

2. Create the missing NAT rule:
```bash
ssh_exec(sn, "iptables -w10 -t nat -I POSTROUTING -s 172.17.0.0/16 ! -o docker0 -j MASQUERADE")
```

3. Restart Docker:
```bash
ssh_exec(sn, "systemctl restart docker && systemctl is-active docker")
```

If it still doesn't work after that — a reboot: `ssh_exec(sn, "reboot")`.

## Pitfalls

- `apt install docker-ce` without `wb-docker-manager.sh` — the rootfs fills up, the controller goes down.
- Forgetting to move data to `/mnt/data/` — everything will be lost during a FIT update.
- Installing heavy packages via `ssh_exec` — a timeout, and the process will be left hanging.
- On a kernel mismatch (`uname -r` ≠ `dpkg -l linux-image-wb*`) kernel modules won't load — a reboot is needed. But switching to iptables-legacy is needed in any case for Docker on WB.

## Documentation

- Docker: <https://wiki.wirenboard.com/wiki/Docker>
- Home Assistant: <https://wiki.wirenboard.com/wiki/Home_Assistant>
- Supported devices: <https://wiki.wirenboard.com/wiki/Supported_devices>
- Community scripts: <https://github.com/wirenboard/wb-community>
