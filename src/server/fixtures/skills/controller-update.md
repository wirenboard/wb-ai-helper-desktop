# controller-update

Updating WB controller packages and switching between releases (suite switching) via `apt` and `wb-release -t`. Load it on ANY mention of updating software on the controller: "update the controller", "apt upgrade", "update the packages", "install updates", "are there any updates", "switch to testing", "go back to stable", "change the release", "roll out a new wb release", "dist-upgrade", "update wb-rules", "update wb-mqtt-serial". As for FIT flashing — **this is not that skill**, we don't run FIT flashing at all (see the system prompt).

**IMPORTANT: read the WHOLE skill before acting. Do NOT call ssh_exec/ssh_exec_async in parallel with load_skill — read the instructions first.**

Scope: **apt update** (`apt update` / `apt upgrade`) and **release switching** (`wb-release -t <suite>`). Both scenarios touch the rootfs, restart services, and on failure can leave the controller in a state where some packages are in one release and some in another. Before any run — a backup via the `controller-backup` skill.

**ssh_exec vs ssh_exec_async — a simple rule:**
- Instant commands (local cache, no network): `ssh_exec` — `wb-release`, `dpkg -l`, `apt list`, `apt policy`, `df`, `uptime`, `systemctl status`.
- Network or long-running: `ssh_exec_async` — `apt update` (pulls indexes from the network), `apt install/upgrade/remove` (downloads + installs), `wb-release -t` (changes repos + update + upgrade).
The server will forcibly block network apt commands via `ssh_exec` and will automatically add `DEBIAN_FRONTEND=noninteractive` + `-y` (for install/upgrade/dist-upgrade/remove/purge) in `ssh_exec_async`. That is, `apt-get install pkg` via `ssh_exec_async` is de facto executed as `DEBIAN_FRONTEND=noninteractive apt-get install -y pkg`. **You don't need to write `-y` by hand** — but if you accidentally added it, the server doesn't duplicate it. Historical case: the model ran `apt-get install` without `-y`, dpkg waited for a Y/N answer, the default was N, the package wasn't upgraded (actually reproduced on A25NDEMJ — wb-mqtt-serial 2.146 vs 2.224 in the repo). After `ssh_exec_async` — wait for the result, the server will nudge you automatically.

## What is what

- **Packages (apt)** — `wb-rules`, `wb-mqtt-serial`, `wb-mqtt-confed` and other wb-\* plus standard Debian packages. Versions within a single release. Updated normally via `apt upgrade`.
- **Release (suite)** — the codename of the repository branch that `/etc/apt/sources.list*` are configured for. Example: `wb-2504` (stable, as of April 2025). Changed via `wb-release -t`. Changing the release is effectively a mass package upgrade from the new repositories + a possible change of the underlying Debian version (bullseye → bookworm, etc.).
- **FIT firmware** — a rootfs image, flashed via the factory button or `wb-fw-update`. Overwrites /. NOT covered in this skill, the model does not run it.

The boundary: `apt upgrade` within the current release is safe, `wb-release -t` changes a whole branch — that's a major change.

## Umbrella consent (important!)

If the user gave explicit **blanket** consent to the whole scenario — "update everything", "do this and everything else", "see it through", "don't ask me every time", "I need the freshest system", "go ahead", "keep going in the same vein" — that is **permission for ALL steps of scenario A** (including `dist-upgrade` for kept back, service restarts, and a reboot after a kernel update). Don't bother the user with "may I?" before every next step — it's annoying and contradicts what they said. Just do it and report the result briefly.

What umbrella consent does NOT cover (always HITL with a separate confirmation):
- Release switch `wb-release -t` (scenario B) — that's a major branch change, not part of "update everything".
- `wb-release -p`/`-r` (scenario D) — recovery operations.
- Any destructive commands outside scenario A (rm -rf, formatting, resetting configs).

If there was no umbrella consent — follow the HITL markup of the steps as written.

## Recon: what's on the controller right now

Before any action — recon in two steps:

**Step 1** — MANDATORY via `ssh_exec` (not `get_controller`! the server automatically attaches information about new releases to the `wb-release` output):

```bash
wb-release 2>&1 | head -20
echo ===
df -h / /mnt/data | awk 'NR==1 || /\/$|\/mnt\/data/'
echo ===
uptime
```

**Step 2** — checking for updates via `ssh_exec_async` (apt update can be slow, the server will block it via ssh_exec):

```bash
apt-get update -qq 2>&1 | tail -20
echo ===
apt list --upgradable 2>/dev/null
```

Don't truncate the `apt list` output — wb packages come at the end of the alphabet, `head` would cut them off.

Wait for completion via auto-polling (the server will nudge automatically).

What to look at:
- **Current release** (`wb-release`) — the model and the suite version.
- **New releases — the server will tell you automatically.** When you call `ssh_exec` with `wb-release` in the command, the server automatically compares the controller's current release with the latest stable on GitHub and attaches a list of new releases with changelog links to the response. If the response contains a "Available release updates" block:
  1. **Explicitly tell the user** about the new release.
  2. **Read the changelog** of the latest release (the link from the response) via `web_fetch` and tell, **compactly and in human terms**, what's new — focus on the benefit: new devices, bug fixes, UI improvements. Don't dump the raw changelog.
  3. Updating to a new stable happens via `apt upgrade` + `apt dist-upgrade` if needed (scenario A), NOT via `wb-release -t`. The `wb-release -t` command is needed ONLY for switching stable↔testing.
- **`apt update`** — did it run cleanly? GPG/404 errors mean broken sources, you can't go further. With `-qq` the output may be empty on success — that's normal.
- **`apt list --upgradable`** — output format: `package/repo version arch [upgradable from: old_version]`. The first line `Listing...` is a header, not data. If lines with packages follow `Listing...` — then there ARE updates, count them. If there's only `Listing...` and nothing else — there's nothing to update. Pay attention to wb-\* packages mixed in with debian core.
- **Free space on `/`** — if <200 MB, apt won't finish unpacking. Clean up first: `apt clean; journalctl --vacuum-time=7d`.
- **Uptime** — if the controller has just come up, wait 1-2 minutes, let rsyslog/wb-* stabilize.

## Clarify: what exactly are we doing

Depending on the user's request — different scenarios. Don't confuse them, and don't glue them into one.

### Scenario A: package update

Triggers: "update the packages", "apt upgrade", "any updates?", "update the controller".

What to do:
1. `save_state_for_diff(sn)` — a snapshot BEFORE.
2. Advise to "assemble a backup via `controller-backup`" — especially if `apt list --upgradable` contains critical packages (`wb-mqtt-serial`, `wb-rules`). For minor updates (utilities, locales) a backup is overkill — decide with the user.
3. Show the user the upgradable list. **HITL: wait for confirmation.**
4. `ssh_exec_async(sn, "apt-get -y upgrade", label="apt upgrade")`.
5. `job_tail` until `state: "exited"`. If `exitCode !== 0` — work through the log, don't hide it from the user.
6. **Check kept back.** If the output contains "kept back" or "not upgraded" — it means some packages weren't upgraded because of new dependencies. Tell the user which packages exactly were held back and suggest `apt-get -y dist-upgrade` for a full update. Show what will be additionally installed/removed (`apt-get -s dist-upgrade | grep -E '^(Inst|Remv)'`). **HITL: wait for confirmation.**
7. Afterwards: `diff_snapshot` to show what changed (package versions, new services).
8. **Check whether the kernel was updated** — look for `linux-image` in the apt output. If the kernel was updated — explain to the user: "The Linux kernel was updated. The new kernel will only take effect after a reboot. Until the reboot the controller runs on the old kernel, and the new modules and drivers may be incompatible — this can cause failures. I recommend rebooting now." **HITL: wait for confirmation**, then `ssh_exec(sn, "systemctl reboot")`. SSH will drop for 30-60 seconds.
9. If the upgradable list contained packages that require a service restart (`wb-rules`, `wb-mqtt-*`), check: `systemctl is-active <unit>`; if it restarted itself — fine, if not — `systemctl restart <unit>` with the user's confirmation.

**A special case — `dist-upgrade`.** If `apt-get -y upgrade` doesn't pull in one of the packages because of a dependency conflict (`The following packages have been kept back`), you can try `apt-get -y dist-upgrade`. But **HITL is mandatory**: dist-upgrade can install new packages and remove old ones, that's a risk. Show the user the diff (`apt-get -s dist-upgrade | grep -E '^(Inst|Remv)'`), wait for confirmation.

### Scenario B: switching the stable↔testing branch via `wb-release -t <suite>`

Triggers: "switch to testing", "go back to stable", "I want the testing branch", "change the suite to testing/stable".

**IMPORTANT:** this scenario is ONLY for switching between branches (stable↔testing). Updating to a new stable release (wb-2504→wb-2602) is done via `apt upgrade` + `dist-upgrade` (scenario A). Don't suggest `wb-release -t` for updating the version within stable.

What to do:
1. Find out the **exact** name of the target release — it changes over time. `web_fetch(https://wirenboard.com/wiki/WB_Software_Releases)` or ask the user. Don't guess: `wb-release -t` doesn't check that such a suite exists before starting, it will fail in the middle of the process.
2. `save_state_for_diff(sn)` + a **mandatory** `controller-backup`. A release change can break custom packages, configs with the modified flag, configs of old driver versions.
3. Show the user: the current release, the target release, an approximate diff of changes (or at least the size — `apt-get -s dist-upgrade` after a temporary sources.list change is inconvenient, better to just warn that a hundred packages will be updated).
4. **HITL.** Get an explicit "yes", repeat what the target release will be.
5. `ssh_exec_async(sn, "wb-release -y -t <target>", label="wb-release -t <target>")`. Without `-y` the process waits for stdin and will hang. Do NOT use `--no-preliminary-update` — the default is correct.
6. `job_tail` at intervals, but note — during the transition SSH may temporarily drop (network/dropbear restart). Wait for `state: "exited"`; if `job_status` returns an SSH error — wait a minute and retry. The process keeps running on the controller (`systemd-run --collect`), even if we temporarily can't see it.
7. After `state: "exited"`: `wb-release` again — it should show the new suite. `apt list --upgradable` — should be empty. If "kept back" packages are hanging — scenario A `dist-upgrade`.
8. `diff_snapshot` against the BEFORE snapshot. Go through the major changes with the user.
9. If the controller reboot doesn't happen automatically — tell the user: "I recommend rebooting after the release change", ask for permission, and on agreement — `ssh_exec(sn, "systemctl reboot")`. After the reboot SSH will temporarily drop for ~30-60 seconds.

`wb-release -p` (`--reset-packages`) and `wb-release -r` (`--regenerate`) — for recovery scenarios, not a normal update. Use them only if you understand why and have confirmed with the user.

### Scenario C: "are there any updates" without immediate action

Triggers: "what's up with updates", "what can be updated".

What to do:
- The recon command above (the server will automatically attach information about new releases). No upgrades.
- Report to the user: the current release, the latest available stable release (if it differs — explicitly say "a new release wb-YYMM is available, it'll be updated via apt upgrade"), N packages in upgradable, of which M are wb-\*. Suggest running scenario A.

## Execute: pattern for long apt/wb-release runs

```
jobId = ssh_exec_async(sn, "<command>", label="<short label>")
loop:
  status = job_status(sn, jobId)
  tail   = job_tail(sn, jobId, fromLine = lastShown)
  show the user the latest lines (if there are new ones)
  if status.state == "exited":
    break
  pause ~10s (don't poll in a loop without pauses — that's tokens too)
```

Don't forget `job_cancel(sn, jobId)` if the user said "cancel" — otherwise the process will keep running.

## Verify: after the update

- `wb-release` — the release is the expected one.
- `apt list --upgradable` — empty (or only "kept back" remain, which the user knows about).
- `systemctl --failed` — no new failed services. If there are — read `journalctl -u <unit> -n 50`.
- `diff_snapshot` — show the user what was added/removed/changed version.
- For critical services (`wb-rules`, `wb-mqtt-serial`, `wb-mqtt-confed`): `systemctl is-active` + `journalctl -u <unit> -n 20` — make sure they started after the restart.

## Scenario D: factory reset / package rollback via wb-release

Triggers: "roll back the packages", "after a failed upgrade", "the controller broke after a release change", "put it back the way it was", "factory reset".

`wb-release` has two recovery modes — these are **NOT** a FIT flash (which we don't run), but a rebuild of the package state from the repositories:

- **`wb-release -p` (`--reset-packages`)** — brings ALL wb-\* packages to the current release's versions. Rolls back (downgrades) what's above; installs what should be there but was removed. Does NOT touch configs in `/etc/` (`dpkg --force-confold` by default).
- **`wb-release -r` (`--regenerate`)** — regenerates system configs from the wb-configs templates. Useful if someone messed up `/etc/network/interfaces` or similar auto-configured files. Custom edits may be overwritten — a `controller-backup` beforehand is mandatory.

What to do (both `-p` and `-r` go the same way):
1. `controller-backup` — **mandatory**. Both modes change packages/configs.
2. Show the user what we're about to do and why. Don't run it as a precaution.
3. **HITL.** Wait for an explicit "yes".
4. `ssh_exec_async(sn, "wb-release -y -p", label="wb-release -p")` (or `-r`).
5. `job_tail` until `state: "exited"`. SSH may temporarily drop — wait, the process is under `systemd-run --collect`.
6. Afterwards: `wb-release` (current state), `apt list --upgradable` (should be empty), `systemctl --failed`.
7. If the reboot didn't happen automatically — suggest `systemctl reboot` with HITL.

**A hardware factory reset** (hold the button → factory firmware via FIT) is a service operation, we don't run it. If the package rollback didn't help — the user has to do FIT themselves per the [wiki](https://wirenboard.com/wiki/Wirenboard_Update).

## What we do NOT do

- FIT flashing (`wb-fw-update`, `swupdate`, `wb-run-update`) — **forbidden**, see the system prompt. If the user asks for FIT — explain that it's an operation for factory service cases, and decline.
- `apt upgrade` without a backup on a production controller with custom packages/configs — the user may lose modified files because of `dpkg --force-confold/confnew`.
- `apt-get -y purge` just to "clean up" — it touches dependencies. If you need to remove a single package — do it precisely with `apt-get remove <pkg>`, showing the dependencies first.
- Changing the release "back" from testing to stable — formally the command is the same (`wb-release -t wb-2504`), but the reverse path may leave packages at a higher version (a downgrade is not done automatically). Warn the user: **after rolling back to stable, `wb-release -p` (reset-packages) may be needed** — it rolls all packages onto the release's versions, with HITL.

## Pitfalls

- Running network/long apt commands (`apt update`, `apt install`, `apt upgrade`) or `wb-release -t` with a plain `ssh_exec` — the server will block it, use `ssh_exec_async`.
- Ignoring `apt list --upgradable` and running upgrade right away — you won't see, for example, that the kernel or wb-core is being updated, where the user should be warned.
- Running `wb-release -t` without `-y` — the process will hang waiting for stdin (nobody will provide it).
- Assuming that after `wb-release -t` the packages will pull themselves in forever — the process is synchronous; if it fails midway, you need to sort it out (`apt-get -f install`, then `apt upgrade`).
- Not backing up before a release change — if custom packages (nodered, zigbee2mqtt) of the new release can't handle the old configs, rolling back is hard.
- Rebooting the controller manually (`reboot`) in the middle of `apt upgrade` — almost guaranteed to break dpkg. Even if SSH hung, the apt process on the controller usually lives on (`systemd-run --collect`), wait for it.
- Not checking `systemctl --failed` after a release change — new packages may fail to enable because of a custom unit file overriding the packaged one; a small breakage, easy to miss.

## Documentation

- GitHub — release list and changelogs: <https://github.com/wirenboard/wb-releases/blob/master/README.md>
- WB wiki — releases and branches: <https://wirenboard.com/wiki/WB_Software_Releases>
- WB wiki — update: <https://wirenboard.com/wiki/Wirenboard_Update>
- WB wiki — data partition (backup): <https://wirenboard.com/wiki/Data_Partition>
- `wb-release --help` on the controller
- For debugging: `/var/log/wb-release.log`
