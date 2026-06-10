# wb-services

systemd services and timers on a Wiren Board controller: managing existing units, override configs for packaged ones, creating your own services and timers. Load on: "make a service from a script", "timer for a backup", "override on ExecStart", "the override disappeared after apt upgrade", "the timer does not fire", "how to run X on boot", "mask/unmask a unit".

**Boundary:** failed services / diagnostics — `troubleshooting-general`. Package updates — `controller-update`.

## Basic commands

Use the `systemd_unit` tool (`action: status/start/stop/restart/reload/enable/disable/mask/unmask/cat/list-deps`) — in a single call it returns a structured object `{active, sub, load, unitFileState, exitCode, mainPid, since, statusTail}`. For read-only checks (status/cat/list-deps), no confirmation is needed. For start/stop/restart/enable/disable/mask/unmask — HITL.

If you need the journal — `wb_logs` or `ssh_exec("journalctl -u <unit> -n 50 --no-pager")`. The full list of failed units — `failed_units`.

`systemctl status <unit>` for a failed unit returns exit 3 — this is a **status code, not an ssh error**.

## Override config (drop-in) — the correct way to change a packaged unit

Never edit `/lib/systemd/system/<unit>.service` directly — apt will overwrite it on upgrade. Use a drop-in:

```bash
ssh root@<HOST> 'mkdir -p /etc/systemd/system/<unit>.service.d'
ssh root@<HOST> 'cat > /etc/systemd/system/<unit>.service.d/override.conf' <<'EOF'
[Service]
Restart=on-failure
RestartSec=10s
EOF
ssh root@<HOST> 'systemctl daemon-reload && systemctl restart <unit>'
```

**To erase a directive from the main file, redeclare it empty:**

```ini
[Service]
ExecStart=
ExecStart=/usr/local/bin/my-wrapped-service
```

Without the first empty-line reset, systemd will append the second to the first instead of replacing it. After that — `daemon-reload`, `restart`, and check `systemctl cat <unit>` (is the drop-in visible) and `systemctl show <unit> -p ExecStart`.

### Example: fix `fstrim.service` with `status=64/USAGE`

A typical case — `/etc/fstab` references `/mnt/sdcard` without an inserted SD card, and fstrim fails.

```bash
ssh root@<HOST> 'mkdir -p /etc/systemd/system/fstrim.service.d'
ssh root@<HOST> 'cat > /etc/systemd/system/fstrim.service.d/override.conf' <<'EOF'
[Service]
ExecStart=
ExecStart=/sbin/fstrim --fstab --quiet-unsupported
EOF
ssh root@<HOST> 'systemctl daemon-reload && systemctl reset-failed fstrim.service'
```

`--quiet-unsupported` skips physically absent mount points.

## Your own service from a script

1. **Script** in `/usr/local/bin/<name>.sh`, owner root, `chmod 0755`.
2. **Unit** in `/etc/systemd/system/<name>.service`:

```ini
[Unit]
Description=My periodic task
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/bin/my-task.sh
StandardOutput=journal
StandardError=journal
```

`Type=oneshot` — for one-shot tasks (typical case — under a timer). For long-lived services — `Type=simple` (default) or `Type=notify` (if the binary can do sd_notify).

3. After creating it — `systemctl daemon-reload`, then check `systemctl start my-task && systemctl status my-task`.

## Timer

A timer is a separate unit `<name>.timer` that launches the same-named `<name>.service`:

```ini
[Unit]
Description=Run my-task every hour

[Timer]
OnCalendar=hourly
Persistent=true
RandomizedDelaySec=2min

[Install]
WantedBy=timers.target
```

After that — `systemctl daemon-reload && systemctl enable --now my-task.timer`.

- **`OnCalendar=hourly`** — once per hour. Full syntax: `OnCalendar=*-*-* 03:00:00` (daily at 03:00), `Mon..Fri 08:00`, `*-*-1 12:00` (the 1st day of the month at 12:00). Test an expression: `systemd-analyze calendar 'Mon..Fri 08:00'`.
- **`Persistent=true`** — if the controller was off at the moment of firing, the timer fires right at boot.
- **`RandomizedDelaySec`** — randomizes the start (useful when several controllers hit a single server).

Alternatives: `OnBootSec=2min` (X after boot) / `OnUnitActiveSec=10min` (every X after the previous run).

The list of timers and their next firing — `systemctl list-timers --no-pager`.

## wb-rules cron vs systemd timer

| Case | What to choose |
|---|---|
| The condition depends on MQTT state, dev[], timers, and other rules | wb-rules `cron(...)` or `setInterval` (see `wb-rules`) |
| A simple shell command on a schedule | systemd timer (this skill) |
| Backup, sync, monitoring — a task not tied to the bus | systemd timer |
| Need to run a task at boot + then daily | systemd timer (`OnBootSec=` + `OnCalendar=`) |
| Reaction to a control change / bus event | wb-rules `whenChanged` (no cron needed) |

## Enable / disable / mask

- `enable` — add to autostart; `--now` additionally starts it immediately.
- `disable` — remove from autostart (the unit remains, can be started manually).
- `mask` — forbid starting (even via dependencies) — a symlink to `/dev/null`. Stronger than `disable`. Use it to disable a packaged service that other services might start (e.g. `bluetooth.service` on headless controllers).
- `unmask` — undo the mask.
- `reset-failed <unit>` — clear the failed status without a restart.

## After apt upgrade

Override and custom units in `/etc/systemd/system/` **survive** apt upgrade — a package may change `/lib/systemd/system/<unit>.service`, but the drop-in stays in effect. If after the upgrade the packaged unit did not pick up the override — `systemctl daemon-reload && systemctl restart <unit>`.

**Custom units in `/etc/systemd/system/` do NOT survive a FIT firmware flash** (it overwrites the rootfs). For a backup — `controller-backup`, section "Custom systemd units".

## Pitfalls

- **Editing `/lib/systemd/system/<unit>.service` directly** — apt overwrites it. Only drop-ins.
- **`ExecStart=` in a drop-in without a reset** — appends a second command to the first. First an empty `ExecStart=`, then the new one.
- **Forgot `daemon-reload`** — systemd does not see the changes. After any edit to a .service/.timer.
- **`enable` without `--now`** — the unit is enabled but did not start in this session. `enable --now` or a separate `start`.
- **Incorrect `OnCalendar`** — check via `systemd-analyze calendar '<expr>'` BEFORE deploying.
- **`Type=oneshot` without `RemainAfterExit=yes`** — after a successful run the unit is "inactive (dead)", not active. For a timer this is normal; if you expect active — add `RemainAfterExit=yes`.
- **A custom unit without an `[Install]` section** — `enable` will fail with "No installation information found".
- **`mask` without a subsequent `unmask`** — a forgotten mask breaks services on the next upgrade.

## Documentation

- systemd unit: https://www.freedesktop.org/software/systemd/man/systemd.unit.html
- systemd timer: https://www.freedesktop.org/software/systemd/man/systemd.timer.html
- OnCalendar format: https://www.freedesktop.org/software/systemd/man/systemd.time.html
