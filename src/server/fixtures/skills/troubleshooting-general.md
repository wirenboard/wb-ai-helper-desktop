# troubleshooting-general

General troubleshooting of problems on a Wiren Board controller. Load this when the user says: "doesn't work", "fix it", "it broke", "error", "won't start", "a service crashed", "problem with…", "collect diagnostics", "diagnostic archive", "logs and state" — and it's NOT about serial/Modbus (for serial there's troubleshooting-serial).

Don't confuse it with backup (`controller-backup`). A diagnostic archive is for analysis and support, not for recovery. It's collected by the `wb-diag-collect` utility and includes: configs from `/etc`, service logs (wb*, mosquitto, NetworkManager, etc.), output of diagnostic commands (df, ps, ip, dpkg, etc.).

## First steps — always

Before fixing — figure out the cause. Don't fix symptoms.

### 0. Documentation — MANDATORY

**Before any fix** call `web_fetch` on the wiki page of the problematic component in the WB wiki. For example: Docker → `web_fetch('https://wiki.wirenboard.com/wiki/Docker')`, Modbus → `web_fetch('https://wiki.wirenboard.com/wiki/Modbus')`, Home Assistant → `web_fetch('https://wiki.wirenboard.com/wiki/Home_Assistant')`. Look for the "Known issues", "Troubleshooting", "Limitations" sections. If the solution is there — apply it, don't invent your own.

### 1. Kernel mismatch

**The most common cause of problems after an update.** Check it first of all:

```bash
echo "running: $(uname -r)"; dpkg -l 'linux-image-wb*' 2>/dev/null | grep ^ii | awk '{print "installed:", $3}'
```

If the versions don't match — the controller is running on an old kernel. Kernel modules (br_netfilter, iptable_nat, can, i2c, etc.) won't load, Docker/iptables/networking may not work. **The only solution is a reboot.** Don't try to work around it via modprobe/iptables-legacy — that's useless on a kernel mismatch.

### 2. Disk space

```bash
df -h / /mnt/data
```

Rootfs < 100 MB — critical: apt doesn't work, logs aren't written, services crash. Cleanup: `apt clean; journalctl --vacuum-time=3d; rm -rf /tmp/*`.

### 3. Crashed services

```bash
systemctl --failed --no-pager
```

For each crashed one: `journalctl -u <unit> -n 50 --no-pager` — the cause is in the logs.

### 4. Error journal

```bash
journalctl -p err -n 50 --no-pager
```

### 5. Load and memory

```bash
uptime; free -h
```

Load > 4 on WB — overload. `top -bn1 | head -20` will show who's eating the CPU.

## Typical problems

| Symptom | First step |
|---|---|
| Service won't start after an update | Kernel mismatch → reboot |
| Docker doesn't start, iptables errors | First a kernel mismatch. If the kernel is OK — iptables-legacy fix (see below) |
| modprobe: module not found | Kernel mismatch → reboot |
| apt doesn't work, dpkg lock | `fuser /var/lib/dpkg/lock-frontend` — who's holding it. If it's a zombie from an interrupted apt: `dpkg --configure -a` |
| Service crashes in a loop | `journalctl -u <unit> -n 100` — find the cause, don't restart blindly |
| No network | `ip addr`, `nmcli`, `ping 8.8.8.8`, `cat /etc/resolv.conf` |
| MQTT doesn't work | `systemctl is-active mosquitto`, `mosquitto_sub -t '#' -C 1 -W 2` |
| Web UI doesn't open | `systemctl is-active nginx wb-mqtt-homeui` |

## Docker and iptables

If Docker doesn't start with errors like `Chain 'MASQUERADE' does not exist`, `DOCKER-ISOLATION-STAGE`, `Failed to Setup IP tables` — and a kernel mismatch has been ruled out:

1. Switch iptables to legacy:
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

If it didn't help — a reboot: `ssh_exec(sn, "reboot")`. More details: <https://wiki.wirenboard.com/wiki/Docker>.

## Diagnostic archive

**Collect it ONLY in two cases:**
1. The user explicitly asks "send the diag archive" / "diagnostic archive"
2. You're composing a bug report — the archive is mandatory as an attachment along with the problem logs

In all other cases (diagnostics, finding the cause, fixing) — **don't create an archive**, work with the logs directly via `ssh_exec`.

```
ssh_exec_async(sn, "wb-diag-collect /tmp/diag", label="collect diagnostics")
```

`wb-diag-collect` takes the argument as a **prefix** and appends `_SN_DATE.zip` itself — the real name is not known in advance. Collection takes 30-60 seconds.

After it finishes — find the file and download it:
```
ssh_exec(sn, "ls /tmp/diag*.zip | tail -1")
fetch_from_controller(sn, "<path from the ls output>")
```

## Principle

Diagnose → read the documentation → explain the cause → propose a solution → wait for confirmation. Don't fix blindly.
