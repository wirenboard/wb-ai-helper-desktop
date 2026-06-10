# history

Data history and charts for Wiren Board controllers. Load this when the user asks about history, trends, charts, or metrics over a period: "show me temperature for the week", "send a voltage chart", "how did the load change", "average temperature over 24 hours", "build a chart", "was there an over-limit event".

## Architecture

- **wb-mqtt-db** — a service on the controller that logs all MQTT channels to SQLite
- **db_logger** — an RPC service for querying history: `/rpc/v1/db_logger/history/get_values/{clientId}`
- **Tools:**
  - `get_history` — data + statistics (points and min/max/avg in the response body; limited to 1000 points/channel to save tokens)
  - `get_history_chart` — PNG chart as an attachment
  - `get_history_table` — CSV table as an attachment (up to 100,000 points/channel) for export into Excel/Google Sheets

## Step 1 — find the right channels (MANDATORY before any history query)

**Never guess channel names.** The examples in this skill are illustrative, **do not copy them literally**: `device_id` depends on the controller and its assembled hardware configuration. First obtain the exact `[device_id, control_name]` pairs from the MQTT of this specific SN.

### Two mandatory calls — both, not just one

```
# 1. List all devices — find the right device_id
mqtt_list_topics(sn, prefix="/devices/+/meta/name")

# 2. List the channels of the selected device — confirm the control_name is there
mqtt_list_topics(sn, prefix="/devices/<device_id>/controls/+")
```

**Do not call `get_history_chart` / `get_history` / `get_history_table` without both calls.** The tools do a pre-flight check via MQTT and will return an error with a hint if `device_id` or `control_name` is not found — don't waste a turn on this, validate it yourself and call with the correct names.

Search by meaning within the full names. Channel names often contain spaces — use them VERBATIM.

**Example:** for hwmon the topics will return:
```
/devices/hwmon/controls/CPU Temperature
/devices/hwmon/controls/Board Temperature
/devices/hwmon/controls/GPU Temperature
```
→ channels = `[["hwmon", "CPU Temperature"], ["hwmon", "Board Temperature"]]`

**Common mistake:** truncating the channel name. `"CPU"` is WRONG, the correct value is `"CPU Temperature"`.

### If you didn't find an unambiguous match

Show the candidates to the user and ask them to choose:
```
Found several similar channels:
1. wb-system / CPU Temperature
2. wb-msw-v4_42 / Temperature 1
3. wb-msw-v4_42 / Temperature 2

Which one are you interested in?
```

## Step 2 — determine the time range

**Always use `period` — the server will compute the correct unix timestamps itself.** Don't compute `from` manually.

| User's description | period |
|-----------------------|--------|
| for an hour | `1h` |
| for 6 hours | `6h` |
| for 24 hours / for a day | `24h` |
| for a week | `7d` |
| for a month | `30d` |

## Step 3 — request data or a chart

### Data only (statistics):
```
get_history(sn=SN, channels=[["hwmon", "CPU Temperature"]], period="24h")
```

The response per channel: an array of points `{v, t}`, statistics `{min, max, avg}`, and also the fields `units` and `precision` (if the driver published them in `/meta`). **Always check `units` before interpreting values in a table/message to the user.** If there are no `units` — don't make up the units (especially "°C"); ask the user or explicitly write "no units".

Example: `Board Temperature` with `units = "°C"` → `43.2 → 72.6 °C`. If `units` is missing and the values look like `307 → 1313` — these are **not degrees**, more likely a raw hwmon value (milli-°C or an ADC code); mark them "units not set".

### PNG chart (when the user asks "show", "send", "draw"):
```
get_history_chart(sn=SN, channels=[["hwmon", "CPU Temperature"]], period="24h",
  title="CPU Temperature over 24 hours", ylabel="°C")
```

The chart will automatically appear in the chat as an attachment — the user will see it and can download it.

### CSV table (when the user asks "export", "save", "drop into Excel", "a table"):
```
get_history_table(sn=SN, channels=[["hwmon", "CPU Temperature"], ["hwmon", "Board Temperature"]], period="7d")
```

Returns a CSV attachment with columns `timestamp_unix, timestamp_iso, <device/control> (<units>), ...`. By default — up to 10,000 points per channel without downsampling; for large dumps you can raise `limit` up to 100,000 and set `min_interval`. The model receives only metadata (number of points, file size) — the values themselves don't enter the context.

## Downsampling (automatic)

| Range | min_interval | limit |
|----------|-------------|-------|
| ≤ 1 hour | 0 (all points) | 200 |
| ≤ 24 hours | 60 s | 500 |
| > 24 hours | 600 s | 1000 |

## Multiple channels on one chart

You can request several channels at once — they'll land on a single chart:
```
get_history_chart(sn=SN,
  channels=[
    ["hwmon", "CPU Temperature"],
    ["wb-msw-v4_42", "Temperature 1"]
  ],
  period="7d",
  title="Temperatures over the week", ylabel="°C")
```

## If wb-mqtt-db is not installed

Check: `ssh_exec(sn, "systemctl is-active wb-mqtt-db")`. If inactive/not-found — history is unavailable, suggest installing it: `apt install wb-mqtt-db`.

## Pitfalls

- **No data for the period** — the channel may not have been logged (wb-mqtt-db was recently installed or the channel is not active).
- **Too many points** — use a large `min_interval`. The tool selects it automatically, but if you request manually via mqtt_rpc — set a limit.
- **device_id and control_name** — take them EXACTLY from the MQTT topics (`/devices/<device>/controls/<control>`), don't guess. Names often contain spaces: `"CPU Temperature"`, `"Board Temperature"`, `"Supply Voltage"` — they can't be truncated.
- **Empty chart (axis 0–1)** — means the channels were not found in db_logger. Check the channel names via mqtt_list_topics and make sure you use the full channel name.
- **Different units** — don't mix °C and V on one chart. Use `ylabel` for the primary unit or make separate charts.
