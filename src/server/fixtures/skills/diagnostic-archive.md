# diagnostic-archive

Collecting a diagnostic archive from a WB controller for the support team. Load this when the user asks: "collect a diagnostic archive", "send me diagnostics", "a dump for support", "an archive with logs for support", "wb-diag-collect".

**This is NOT a backup** (to restore a controller — see the `controller-backup` skill) and **not a full bug report** (problem description + archive — see the `bugreport` skill). This is just the archive.

## What it is

`wb-diag-collect` is a standard WB utility that collects system logs, package versions, MQTT/Modbus/network configs, dmesg, and systemd state into a single zip. This archive is enough for a support engineer to see the context without extra questions.

## How to collect and deliver it

### 1. Start the collection

```
ssh_exec_async(sn, "wb-diag-collect /mnt/data/ai/wb-ai-helper/diag", label="diagnostics collection")
```

The utility takes the argument as a **prefix** and appends `_SN_DATE.zip`. It runs for 10–30 sec.

### 2. Find the resulting file

```
ssh_exec(sn, "ls -t /mnt/data/ai/wb-ai-helper/diag*.zip 2>/dev/null | head -1")
```

### 3. Deliver it to the user

```
fetch_from_controller(sn, "<path from the ls output>")
```

### 4. Short report

- file name and size
- what's inside (briefly: "logs, dmesg, MQTT/network configs, package versions")
- where to attach it: a support ticket; if the user is creating one — offer to switch to `bugreport`

## Pitfalls

- Don't invent `wb-diag-collect --help`-style arguments. There is one positional argument — the path prefix.
- Don't put it in `/tmp` — the archive may be lost on reboot. Only in `/mnt/data/ai/wb-ai-helper/diag*`.
- Don't confuse it with a backup — the diagnostic archive contains no user data, compose files, or projects. It's only for support.
