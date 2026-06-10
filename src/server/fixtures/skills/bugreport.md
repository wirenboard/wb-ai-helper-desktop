# bugreport

Composing a bug report for Wiren Board support. Load it when the user asks: "compose a bug report", "write an error report", "help me file a bug", "I need to send this to support", or when diagnostics turn up a problem that can't be solved on the spot.

## Before writing a bug report

Read the documentation for whatever broke — it often has a section on known issues. For example, Docker — `web_fetch('https://wiki.wirenboard.com/wiki/Docker')`, Modbus — `web_fetch('https://wiki.wirenboard.com/wiki/Modbus')`. Look for "Known issues", "Limitations", "Troubleshooting" blocks.

If a solution is found in the documentation — suggest applying it. If you can do it yourself — do it with the user's confirmation. No bug report is needed if the problem gets solved.

## Principle

Gather as much as you can yourself, ask as little as possible. Only ask what cannot be learned from the controller: how it is physically connected, what the user sees in the browser/on the screen, what they did by hand outside the controller.

## Workflow

### 1. Gather everything you can yourself

In a single command via `ssh_exec`:
```bash
echo "=== HW ==="; cat /var/lib/wirenboard/short_sn 2>/dev/null; wb-release 2>&1 | head -5; echo "Kernel: $(uname -r)"; echo "FW: $(cat /etc/wb-fw-version 2>/dev/null)"; echo "Uptime:"; uptime; echo "=== DISK ==="; df -h / /mnt/data; echo "=== FAILED ==="; systemctl --failed --no-pager; echo "=== ERRORS ==="; journalctl -p err --since '1 hour ago' -n 30 --no-pager
```

If the problem is with a specific service — its logs: `journalctl -u <unit> -n 100 --no-pager`.

Kernel mismatch: `uname -r` vs `dpkg -l linux-image-wb*`.

### 2. Collect a diagnostic archive (mandatory for a bug report)

Use the `diagnostic-archive` skill — it does exactly this: runs `wb-diag-collect`, fetches the zip. Attach the resulting archive to the bug report.

### 3. Describe what happened

From the dialogue context you already know: what actions led to the problem, what was expected, what happened. Describe it yourself, without asking again.

### 4. Ask only what you cannot find out

- Physical connection (if the problem is with hardware/the bus)
- What the user sees in the browser/on the screen (if the problem is with the UI)
- Whether the problem reproduces and how often
- Whether unnecessary hardware can be disconnected to simplify

Ask briefly, in a single list, not one question at a time.

### 5. File the bug report

Template:

1. **Hardware** — SN, release, kernel, fw, what's connected
2. **Actions** — what was done
3. **Expectation** — what should have happened
4. **Fact** — what actually happened (with logs/data)
5. **Reproducibility** — yes/no, how often
6. **Minimal configuration** — what can be disconnected
7. **Diagnostics** — archive, package versions, logs

Show it to the user for review. Concise, to the point, no fluff.
