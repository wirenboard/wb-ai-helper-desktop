# controller-backup

Backup and restore of a WB controller — assemble an archive with configs, data and package lists; hand it to the user; restore after a flash or onto a new controller. Load it on "make a backup", "backup the controller", "save the controller", "send me a backup", "backup before updating", "roll back after a flash", "restore from backup", "migrate settings".

**This is NOT a diagnostic archive.** If the user asks for a "diagnostic archive", "logs for support", "wb-diag-collect" — that's the `diagnostic-archive` skill, not a backup. A backup is the full controller restore process (packages, configs, data, RESTORE.md), takes minutes.

**THERE IS NO BACKUP UTILITY ON THE CONTROLLER.** There is no `wb-backup`, `wbctl backup`, `backup.sh` — don't make them up. The backup is assembled in the 3 phases below.

**Backup = tar.gz archive** with files, configs, package lists. `save_state_for_diff` is NOT a backup, but a snapshot for verification. Continue to phase 2.

**All files go to `/mnt/data/ai/wb-ai-helper/backups/`.** Don't scatter them across `/tmp`, `/root`, `/mnt/data/backups`. The `$B` variable below already points to the correct directory.

## Checklist — print it after each step

**THE BACKUP IS NOT DONE** until ALL steps are passed. After completing each step (including receiving the result of a background job), print the checklist and **immediately move on to the next unfinished step**. Don't stop, don't ask the user — go all the way and send the archive.

```
Backup progress:
[✓] Phase 1: audit and report
[⏳] Phase 2.1: core archive (metadata + configs)
[ ] Phase 2.2: audit-files (custom files per the audit)
[ ] Phase 2.3: Docker volumes (if any)
[ ] Phase 3.1: RESTORE.md
[ ] Phase 3.2: final packaging
[ ] Phase 3.3: delivery to the user
```

Skip steps that aren't needed (e.g. Docker volumes if there's no Docker), but mark them `[—]`. The step with `[⏳]` is the current one. **Don't print "backup done" until all steps are `[✓]` or `[—]`.**

## Phase 1 — audit and plan (the model's first response)

### Step 1: gather data

Run both calls:
1. `audit_controller(sn)` — what's custom on the controller
2. `save_state_for_diff(sn)` — a snapshot for verification after restore

### Step 2: report of differences from stock

In the message to the user, print the **differences from a typical controller** — this is a useful artifact in its own right:
- Additionally installed packages (`extraPackages`) — list with versions
- Enabled services beyond stock (`extraEnabledServices`)
- Custom files and scripts (`customFiles`, `customSystemdUnits`) — with paths
- Modified configs (`modifiedConfigs`) — exactly which ones
- User directories under `/mnt/data/` (`mntdataUserDirs`) — with sizes
- Docker — whether installed, how many volumes/containers

Don't dump raw JSON — structure it for humans. This is the first part of the response the user sees.

### Step 3: compile the list of paths and immediately launch phase 2

Based on the audit results, assemble the **full list of paths** for the archive. Sources:

| Audit field | What to do with it |
|---|---|
| `customFiles` (`/opt/`, `/usr/local/bin/`, `/usr/local/sbin/`) | Add each path to the list |
| `customSystemdUnits` | Add the unit files. Read `ExecStart=` — if the script is not from a package, add it too |
| `modifiedConfigs` | Add each modified config |
| `mntdataUserDirs` | These are **user projects** (not Docker storage!). Add each directory, show the size |
| `extraPackages` not in the table below | `ssh_exec(sn, "dpkg -L <pkg> \| grep -E '^/(etc\|var/lib\|opt\|srv)'")` — add the found paths |
| `extraEnabledServices` | Don't archive — it's recorded into `services-enabled.list` automatically |

**Size heuristic — without confirmations:**
- Directory < 100 MB → include it.
- Directory 100 MB – 1 GB → include it, but **warn in the message** "such-and-such directory is N MB — it will go into the archive".
- Directory > 1 GB or named Docker volumes with a DB → **skip**, list them in the message as "not included in the archive, request separately if needed".
- The total limit of the final archive is ~2 GB. If the heuristic pushes past that — trim the largest ones first.

In a single message to the user: the differences report + "including in the archive: …; skipping as too large: …". **Don't wait for a reply** — proceed straight to phase 2.

## Phase 2 — assembling the archive

**All steps drop files into a single directory `$B`.** In phase 3 the whole directory is packed into one archive — there's no need to merge manually.

### Step 1: metadata and core configs

Run THIS script via `ssh_exec_async`. Don't invent your own script for this part.

```
ssh_exec_async(sn, "set -e; TS=$(date +%Y%m%d-%H%M%S); B=/mnt/data/ai/wb-ai-helper/backups/$TS; mkdir -p $B; cat /etc/wb-fw-version > $B/fw-version 2>/dev/null || true; cp /usr/lib/wb-release $B/wb-release 2>/dev/null || true; apt-mark showmanual > $B/packages-manual.list; dpkg-query -W -f='${Package}=${Version}\n' > $B/packages-all.list; systemctl list-unit-files --state=enabled --no-legend | awk '{print $1}' > $B/services-enabled.list; find /etc -maxdepth 3 -type l -exec sh -c 'T=$(readlink -f \"$1\"); case \"$T\" in /mnt/data/*) echo \"$1 -> $T\";; esac' _ {} \\; > $B/symlinks-etc.list; tar czf $B/core.tar.gz -C / --warning=no-file-changed --ignore-failed-read mnt/data/etc etc/wb-rules etc/wb-mqtt-serial.conf etc/wb-mqtt-serial.conf.d etc/network etc/hostname etc/resolv.conf etc/ntp.conf etc/chrony 2>/dev/null || true; find / /mnt/data -xdev \\( -path /mnt/data/.docker -o -path /mnt/data/var/lib/containerd \\) -prune -o \\( -name 'docker-compose.y*ml' -o -name 'compose.y*ml' \\) -print 2>/dev/null | tar czf $B/compose-files.tar.gz -T - 2>/dev/null || true; SNAP=$(ls -t /mnt/data/ai/wb-ai-helper/snapshots/snapshot-*.json 2>/dev/null | head -1); [ -n \"$SNAP\" ] && cp \"$SNAP\" $B/state-snapshot.json; echo BACKUP_DIR=$B; du -sh $B $B/*", label="backup controller")
```

From the job output, take the `BACKUP_DIR=...` path — for example `/mnt/data/ai/wb-ai-helper/backups/20260419-224500`. **Substitute this specific path into all subsequent steps.** Don't write `$B` in the following `ssh_exec_async` — the variable does not persist between calls!

### Step 2: data per the audit results

```
ssh_exec_async(sn, "tar czf /mnt/data/ai/wb-ai-helper/backups/<ts>/audit-files.tar.gz --warning=no-file-changed --ignore-failed-read <paths from the audit> 2>/dev/null || true; du -sh /mnt/data/ai/wb-ai-helper/backups/<ts>/audit-files.tar.gz", label="backup audit files")
```

Substitute the **specific paths** from step 3 of phase 1:
- `customFiles`: `/opt/my-app/`, `/usr/local/bin/my-script.sh`
- `customSystemdUnits`: `/etc/systemd/system/my-service.service`
- `modifiedConfigs`: `/etc/mosquitto/mosquitto.conf`
- `mntdataUserDirs`: `/mnt/data/picoclow-docker/` — these are user projects, back them up!
- `extraPackages` configs: paths from `dpkg -L`
- Configs of known packages (table below): `/mnt/data/root/zigbee2mqtt`, `/etc/mosquitto`, `/etc/nginx`, `/etc/grafana`, `/var/lib/grafana/grafana.db`, `/etc/influxdb`, `/root/.node-red/flows*.json`, `/root/.node-red/settings.js`, `/mnt/data/etc/docker`, `/etc/cron.d`

### Step 3: named Docker volumes (if Docker is present)

If `extraPackages` contains `docker-ce`:
```
ssh_exec(sn, "docker volume ls -q 2>/dev/null")
```
If there are volumes with data:
```
ssh_exec_async(sn, "B=/mnt/data/ai/wb-ai-helper/backups/<ts>; for v in $(docker volume ls -q); do docker run --rm -v $v:/data alpine tar czf - /data > $B/docker-volume-$v.tar.gz 2>/dev/null; done; ls -lh $B/docker-volume-*.tar.gz 2>/dev/null", label="backup docker volumes")
```

## Phase 3 — delivery (after ALL jobs finish)

Wait for all phase 2 steps to finish (core + audit-files + docker volumes if any).

### 1. RESTORE.md

Generate and write the restore instructions:
```
write_file(sn, '/mnt/data/ai/wb-ai-helper/backups/<ts>/RESTORE.md', '...')
```
Contents — based on the actual audit data. **Mandatory** sections (don't skip any):

1. **Packages** — list ALL `extraPackages` from the audit. For Docker — via `wb-docker-manager.sh` (see the `software-install` skill). For the rest — `apt install <pkg1> <pkg2> ...`. Order: dependencies first, then dependents. **This section is critical** — without packages the configs are useless.
2. **Files** — what to unpack and where (`tar xzf core.tar.gz -C /`, `tar xzf audit-files.tar.gz -C /`)
3. **Symlinks** — which to restore (from `symlinks-etc.list`)
4. **Services** — which to enable (`systemctl enable ...`) — per the `extraEnabledServices` list from the audit
5. **Manual steps** — what can't be automated (Docker images: `docker compose pull`, DBs, node_modules)
6. **Verification** — `diff_snapshot(sn, "path/to/state-snapshot.json")`

Write specific paths, package names and commands — not `$variables` and not `<placeholder>`.

### 2. Assemble into a single file

```
ssh_exec_async(sn, "cd /mnt/data/ai/wb-ai-helper/backups && tar czf backup-<ts>.tar.gz <ts>/ && du -sh backup-<ts>.tar.gz", label="pack backup")
```

### 3. Check the size and hand it over

```
ssh_exec(sn, "stat -c%s /mnt/data/ai/wb-ai-helper/backups/backup-<ts>.tar.gz")
```
- < 200 MB → `fetch_from_controller(sn, '/mnt/data/ai/wb-ai-helper/backups/backup-<ts>.tar.gz')`
- > 200 MB → suggest `scp` (the user runs it themselves)

### 4. Final report

- Which additional packages need to be installed during restore (from the audit's `extraPackages`) — list the specific names
- What was saved (specific paths)
- What was NOT saved — warn about it:
  - `/mnt/data/.docker/` (the Docker daemon's internal storage: images, layers) — restored via `docker pull` / `docker compose pull`
  - Large DBs (InfluxDB) — `influxd backup` manually
  - Node-RED `node_modules` — restored via `npm install`

## Docker: what to back up, what not

**Don't confuse user projects with Docker storage!**

| What | Where | Back up? | How |
|---|---|---|---|
| compose files | in projects (`/mnt/data/<project>/`) | YES | tar as is |
| bind-mount data | in projects | YES | tar as is |
| named volumes | `docker volume ls` | YES, if there's data | `docker run --rm -v vol:/d alpine tar czf - /d > vol.tar.gz` |
| Docker daemon (`/mnt/data/.docker/`) | internal storage | NO | images via `docker pull`, restored from compose |
| Daemon config | `/mnt/data/etc/docker/` | YES | already in the core archive |

Example: `/mnt/data/picoclow-docker/` (82 MB) — this is a **user project** with compose, configs and data. It MUST be backed up in full. Whereas `/mnt/data/.docker/` holds image layers, backing them up is pointless.

## Known packages — what's in the archive, what to warn about

| Package | What's in the archive | What to warn about |
|---|---|---|
| `docker-ce` | `/mnt/data/etc/docker/`, compose files, projects from `mntdataUserDirs` | `/mnt/data/.docker/` is NOT in the archive. Docker is installed via `wb-docker-manager.sh` (see `software-install`). Named volumes — separately |
| `zigbee2mqtt` | `/mnt/data/root/zigbee2mqtt/` | — |
| `nodered` | `flows*.json`, `settings.js` | `node_modules` restored via `npm install` |
| `mosquitto` | `/etc/mosquitto/` | — |
| `influxdb` | `/etc/influxdb/` | DB via `influxd backup`, not tar |
| `grafana` | `/var/lib/grafana/grafana.db`, `/etc/grafana/` | — |
| `nginx` | `/etc/nginx/` | Certificates `/etc/letsencrypt/` — separately |

## What survives FIT, what doesn't

FIT overwrites the rootfs, does NOT touch `/mnt/data/`.

| Survives | Erased |
|---|---|
| `/mnt/data/` in full | `/usr/local/bin/`, `/opt/`, `/srv/` |
| Configs symlinked into `/mnt/data/etc/` | `/etc/cron.d/<custom>`, `/etc/systemd/system/<custom>` |
| Network/time from the web interface | apt packages outside stock |

## Restore

1. Find the backup: `ssh_exec(sn, "ls -lt /mnt/data/ai/wb-ai-helper/backups/")` (survives FIT). Or the user uploads it via chat → `upload_to_controller`.
2. Read RESTORE.md: `read_file(sn, '/mnt/data/ai/wb-ai-helper/backups/<ts>/RESTORE.md')`.
3. Execute step by step with the user's confirmation. Packages — via `ssh_exec_async`.
4. Verification: `diff_snapshot(sn, "/mnt/data/ai/wb-ai-helper/backups/<ts>/state-snapshot.json")`.

## Pitfalls

- Making up `wb-backup`, `wbctl backup`, `backup.sh` — they don't exist.
- The core script must not be changed. But the audit-tar (step 2 of phase 2) — must be built from the audit data, don't skip the findings.
- Stopping at `save_state_for_diff` — that is NOT a backup. Continue to phase 2.
- Running tar in `ssh_exec` — timeout. Only `ssh_exec_async`.
- Backing up `/etc` or `/mnt/data` in full — huge and useless.
- Staying silent about `/mnt/data/.docker/` — warn that it's not in the archive.
- Dumping raw audit JSON — show a report by category.
- Scattering files across `/tmp`, `/root`, `/mnt/data/backups` — everything goes into `/mnt/data/ai/wb-ai-helper/backups/`.
- Skipping `modifiedConfigs` or `customSystemdUnits` — they are needed in the archive too.

## Documentation

- FIT-update: <https://wirenboard.com/wiki/Wirenboard_Firmware_Update>
- Data partition: <https://wirenboard.com/wiki/Data_Partition>
