# Changelog

All notable changes to the project are documented in this file.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
versioning: [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed
- **Model-facing text is now English-first (single language).** The persona
  system prompt and the other strings the model reads — the force-compaction
  notice, the last-iteration nudge, log-truncation markers, RPC error messages,
  the job-tail hint, the empty-todo placeholder, the chat-context suffix — were
  translated from Russian to English. This matches the documented i18n principle
  (model-facing = single-language English; the model bridges languages itself)
  and removes the Russian language gravity that made weaker models drift to
  Russian. The reply language is still set solely by `LANG_DIRECTIVE` (driven by
  the UI language). The internal protocol sentinel was also renamed `[Система]`
  → `[System]`.

### Added
- **English language (RU/EN).** Toggle in Settings → «Interface»,
  auto-detection by browser language, env `WB_HELPER_LANGUAGE`. The UI is fully
  localized via a lightweight module `src/web/i18n.ts` (without vue-i18n).
  The assistant **replies strictly in the UI language** (directive in the
  system prompt). Skills and tool descriptions are translated into English as a
  single set — they are model-facing instructions, so there is no per-language
  duplication (the model bridges languages in its reply to the user).

### Fixed
- **SSH dialed an IPv6 link-local address → ECONNREFUSED, while the controller
  was reachable over HTTP.** `discovery.resolveKnown()` resolves the `.local`
  hostname with `dns.lookup(..., {family: 0})`, which returns both IPv4 and IPv6
  — including link-local `fe80::` addresses that mDNS announces. `SshPool`
  dialed `addresses[0]`, and when that happened to be the link-local IPv6, the
  connection was refused (it needs a zone id and sshd doesn't listen there).
  Added `preferredSshHost()`: prefer an IPv4 literal → a routable IPv6 → the
  hostname (let the OS resolve) → never a bare link-local. `SshPool.baseConfig`
  uses it. (+14 unit tests for `isIPv4`/`isLinkLocalIPv6`/`preferredSshHost`.)
- **The model replied in the wrong language.** Two causes: (1) the system prompt
  with the language directive was baked once at chat creation — after switching
  the language in Settings, existing chats kept the old language; now the leading
  system turn is regenerated to the current language on every send. (2) The
  language directive was a single line at the tail of the huge Russian system
  prompt, and weaker models ignored it, anchoring on Russian. The directive is
  moved to the front of the prompt as a separate top-priority block and rewritten
  firmly: «reply strictly in the UI language, this overrides the language of the
  instructions below».

## [0.13.22] — 2026-05-13

### Fixed
- **Regression in 0.13.21: SSH was knocking not on port 22 but on the mDNS-announce
  port from `_workstation._tcp` (9) or `_http._tcp` (80).** In 0.13.21 the
  `Controller.port` field started being used in `SshPool.baseConfig`, but
  `Discovery.onService` accepted `svc.port` from any service type.
  Symptom: after an mDNS scan all auto-discovered controllers
  fell into an SSH timeout. Fix: `port` is taken only from `_ssh._tcp`
  announcements, and only if it differs from 22 (default). Manual
  entries with an explicit `host:port` are not affected.
- In `avahiBrowse` the service-type field (`p[4]`) is now parsed and
  passed into `onService` — previously it was also filtered "by accident",
  because `port` in baseConfig was ignored.

## [0.13.21] — 2026-05-13

### Added
- **Connecting to a controller by IP/hostname and a non-standard SSH port.**
  The "add manually" field in the right panel now accepts the syntax
  `host[:port]` — e.g. `192.168.1.10`, `192.168.1.10:2222`,
  `wirenboard-abc.local:8022`. The port is stored in `manual_controllers`
  (migration `ALTER TABLE … ADD COLUMN port INTEGER`, idempotent) and
  used by `SshPool` instead of the default 22. If no port is given —
  behavior is unchanged (port 22). On the controller card, next to the host,
  `:<port>` is shown when it differs from 22.
- **Ad-hoc controller by IP[:port] from a tool call.** If the LLM passes an
  IP or hostname (optionally with `:port`) in `sn` that is not in the registry —
  `adHocController` assembles a temporary `Controller` with that host and
  port, and the SSH call goes through without a prior "add it to the list".
  Previously the port was silently ignored → an attempt to connect on 22 hung.
- **A `host` parameter in all tools alongside `sn`.** Every tool schema
  that accepted `sn` now also accepts `host` (IP, hostname,
  or host:port). `resolve1`/`resolveTargets` handle both:
  if `host` is given — it wins (an explicit intent to address ad-hoc);
  otherwise `sn`; otherwise a fallback to `ctx.contextSns`. Old calls with `sn`
  work as before — the `host` parameter is additional.
  A selection rule was added to the system prompt: `sn` for serials from
  `list_controllers`, `host` for IPs/hostnames mentioned in the chat.
- **`get_controller` returns `hardwareSn` from `/var/lib/wirenboard/short_sn`.**
  The authoritative sticker SN — not the hostname suffix (which the
  user configures). If the file is missing (old firmware / non-WB hardware) —
  the field comes back empty. The prompt explicitly forbids deriving the SN from the hostname.
- Removed the dead function `notFound`; 8 tools (`probe_controller`,
  `list_controls`, `mqtt_read`, `ssh_read_file`, `ssh_read_logs`,
  `read_file`, `fetch_from_controller`, `upload_to_controller`)
  switched to a unified `resolve1` instead of the inline
  `discovery.get→getOrCreate→adHocController`.

## [0.13.20] — 2026-05-09

### Fixed
- **SSH sessions: a limit on parallel channels.** Symptom: a history request
  for 6+ channels (inside `get_history`/`get_history_chart`/`get_history_table`)
  hit the controller's `MaxSessions` — `mqttRpc` under the hood does
  `mosquitto_sub`/`_pub` via ssh exec, and `Promise.all` over channels opened
  one channel each. Likewise — pre-flight via
  `mqtt_list_topics` (per unique device) and the background job-tracker with 5+
  running jobs on a single controller.
- A per-controller semaphore `MAX_PARALLEL_CHANNELS = 7` was added to `SshPool`
  (sshd on WB is configured with `MaxSessions=10`; ~3 slots are left for the user
  for manual ssh connections). The semaphore wraps `exec`, `writeFile`,
  `writeFileBuffer`, `downloadFile`, `openShell`. `connect()` is outside
  the semaphore — the handshake does not eat a slot. The queue is FIFO, new calls do not
  jump ahead of those waiting. An interactive shell holds a slot for the whole session.

### Changed
- **`controller-update.md`: umbrella consent.** Previously the skill required
  HITL before each step of scenario A (apt upgrade → kept back? →
  dist-upgrade → kernel updated? → reboot), even if the user had already
  said "update everything, don't ask". An "Umbrella consent" section was added:
  phrases like "update everything", "do this and all the rest", "go", "see it
  through", "don't ask every time", "I need the latest" —
  permission for ALL steps of scenario A. It does not cover a release change
  (`wb-release -t`), `wb-release -p/-r`, or destructive commands outside
  scenario A — HITL remains there.

## [0.13.19] — 2026-05-08

### Fixed
- **Pre-flight validation in the history tools.** Symptom: the model called
  `get_history_chart` with a made-up `device_id` (`wb-system`), the tool
  successfully saved an empty SVG (db_logger returned 0 points, no error).
  Root cause — two layers:
  1. The `history.md` skill itself suggested a false example with `wb-system`
     in Step 3, even though Step 1 had the correct `hwmon`. The model copied
     the Step 3 example literally.
  2. The tools did not validate channel existence before querying the DB.
- **`get_history`, `get_history_chart`, `get_history_table`** now
  do a pre-flight via MQTT (`mqtt_list_topics(prefix="/devices/<dev>/controls/+")`,
  in parallel over unique `device_id`s). For a nonexistent `device_id` —
  a short error without listing devices. For a nonexistent
  `control_name` — a list of just that one device (5-30 controls,
  not hundreds). The pure helper `diagnoseHistoryChannels` is exported for tests.
- In `history.md` all `wb-system` examples were replaced with the correct `hwmon`
  (the device_id for CPU/Board/GPU Temperature on WB), Step 1 reinforced with an explicit
  instruction about the two mandatory `mqtt_list_topics` calls.

### Tests
- New file `tests/diagnose-history-channels.test.ts` — 8 unit tests
  for the pure helper. Total 387 pass.

## [0.13.18] — 2026-05-08

### Changed
- **Refinements to existing skills** (the last batch from the backlog):
  - `controller-update.md` — added **Scenario D: factory reset / package
    rollback** via `wb-release -p` (`--reset-packages`) and `-r`
    (`--regenerate`). The difference is described: `-p` brings wb-\* packages to the versions
    of the current release (downgrade if needed, does not touch configs),
    `-r` regenerates system configs from wb-configs templates (risk of
    overwriting customizations → mandatory `controller-backup`). An explicit
    distinction from the hardware factory reset (FIT firmware), which we
    do not run.
  - `zigbee.md` — expanded the **Z2M in Docker** section: a typical
    `docker-compose.yml` with `network_mode: host`, passing `/dev/ttyMODx`
    into `devices:`, mounting `./data` for the config. Adapters (`ezsp` for
    WBE2R-R-ZIGBEE v.2). Gotchas: without host network mosquitto is not visible,
    the WB converter config installs on the host (not in the container), `docker compose`
    without the hyphen.
  - `wb-mqtt-serial.md` — added a block about **channel error flags
    (WB MQTT Conventions)**: `r` (read error), `w` (write error),
    `p` (period miss). Key point: with `r` the control's value is last-known-good,
    not fresh → you must not read a control without checking `meta/error`. The scenario
    "check if a channel is alive" via `mqtt_read` on `meta/error`. A link
    to `troubleshooting-serial` for diagnosing the bus physics on `r`/`rp`.

  No backend changes — only updated fixtures, which are seeded
  into the DB at startup via `embed-skills-manifest`.

### Backlog status
- ✅ All 7 system-stack skills published (v0.13.15–v0.13.17).
- ✅ Refinements to existing skills from the backlog (this release).
- `mqtt_list_topics` pagination already exists from previous releases.
- `mqtt_write` handles errors via try/catch on the mqtt client.

The backlog from `wb-ai-skills/wb-ai-helper-analysis.md` is closed.

## [0.13.17] — 2026-05-08

### Added
- **`wb-serial-templates`** — the last of the 7 system-stack skills from the backlog
  `wb-ai-skills/wb-ai-helper-analysis.md`. Creating custom Modbus
  templates for `wb-mqtt-serial`: where templates live (`/usr/share/...` packaged
  vs `/etc/wb-mqtt-serial.conf.d/templates/` user-defined, surviving an
  upgrade), the full set of channel fields (`reg_type`, `format`, `scale`,
  `word_order`, `condition`, `error_value`, `unsupported_value`, etc.),
  `parameters` for firmware settings, `groups` for the UI hierarchy, `translations`
  for i18n. The workflow from reading the manual to a backup in `/wb-controller-backup`.
  A ready-made example of a single-phase electricity meter. Gotchas:
  endianness (a 65535 multiplier on a `word_order` error), 0-based vs 1-based
  addresses, Cyrillic in `device.id`, a duplicate `device_type`.

  Total 24 system skills (was 23 in v0.13.16). All 7 skills from
  the backlog are published.

## [0.13.16] — 2026-05-08

### Added
- **3 new skills** in `src/server/fixtures/skills/` (continuing the backlog
  from `wb-ai-skills/wb-ai-helper-analysis.md`):
  - **`wb-notifications`** — Telegram/email/SMS from wb-rules via `Notify.*`
    and centralized alarms via `alarms.conf`. Creating a Telegram bot
    via `@BotFather`, getting a `chat_id` (personal/group/channel).
    A local MTA via `msmtp-mta` for email (Gmail App Password). SMS
    via ModemManager (`mmcli`). Declarative alarms with `interval`
    for repeated notifications and `expectedValueParameter`/min/max for
    thresholds. Gotchas: a hardcoded token, Cyrillic in SMS (70 characters
    per one), Gmail without an App Password.
  - **`wb-scenarios`** — a declarative no-code engine on top of `wb-rules`:
    4 scenario types (`devicesControl`, `lightControl`, `thermostat`,
    `schedule`) described in JSON in `/etc/wb-scenarios.conf`, generating
    `.js` rules under the hood. The "scenario vs wb-rules" boundary: complex
    conditions / computations / counters → wb-rules. The service is called
    `wb-scenarios-reloader` (NOT `wb-scenarios.service`).
  - **`wb-mqtt-broker`** — administering `mosquitto` on the controller:
    the structure of `/etc/mosquitto/conf.d/` (do NOT edit `mosquitto.conf`
    directly), passwords (`mosquitto_passwd -c` gotcha), per-user ACLs, TLS
    on 8883 (a self-signed CA for home, Let's Encrypt for prod), bridges
    to external brokers (HA, cloud) with `cleansession false`. The principle:
    WB services via a Unix socket (anonymous), external clients — 1883/8883
    with authentication. `per_listener_settings true` is key.

  All 3 skills are loaded automatically during the build via
  `embed-skills-manifest` and seeded into the DB at startup. Total 23 system
  skills (was 20 in v0.13.15).

## [0.13.15] — 2026-05-08

### Added
- **3 new system-stack skills** in `src/server/fixtures/skills/` — compact
  (~100 lines each) versions matching the style of the existing fixtures:
  - **`wb-services`** — managing systemd units, override configs
    (drop-ins for packaged ones), creating your own services and timers. A cheat sheet
    for the `systemd_unit` tool + the correct override pattern (with an `ExecStart=`
    reset before re-overriding). An example fix of `fstrim.service`
    with `--quiet-unsupported`. A comparison of wb-rules cron vs a systemd timer.
  - **`wb-network`** — NetworkManager + wb-connection-manager: connecting
    to WiFi, an access point, a static IP, 4G/sim1/sim2, an OpenVPN client,
    DNS, diagnosing "no internet". Points to using `network_status`
    as the first call. A description of the architecture (NM makes connections, WCM
    prioritizes/fails over).
  - **`wb-cloud`** — wb-cloud-agent: activation (binding to an account),
    unbinding/reset, your own backend via `CLOUD_BASE_URL`, diagnosing
    "not connecting to the cloud". Points to using the `cloud_status`
    tool. An architecture block about ATECCx08 and MQTT state publishing.

  The skills are loaded automatically during the build (via `scripts/build.ts`
  embed-skills-manifest, see v0.13.6) and seeded into the DB at app startup.
  The parametric test `tests/skills-parse.test.ts` validates each
  shipping `.md` via `extractDescription` — all 3 pass.

## [0.13.14] — 2026-05-08

### Added
- **`modbus_device_info`** — the firmware parameters of a specific Modbus device:
  fw, model, current parameter values (debounce, modes, mappings, etc.).
  RPC `wb-mqtt-serial/device/LoadConfig`. This is **not** a list of channels — for
  that there is `modbus_template`. Two modes: (1) by `device_id` (the MQTT name
  like `wb-mr6c_138`) — wb-mqtt-serial resolves the rest itself; (2) by
  explicit `path + slave_id` (+ optionally device_type/baud_rate/parity/
  data_bits/stop_bits) — for devices not in the config.
- **`modbus_probe`** — a point ping of a single Modbus slave-id on the given
  port via `wb-mqtt-serial/device/Probe`. Does not change the config, does not
  restart the driver. Useful when `wb_bus_scan` missed a
  device (a known case with WB-MAP6S — the scanner does not always see it,
  Probe does).
- **`modbus_ports`** — the parameters of all configured RS-485 ports
  (path, baud_rate, parity, data_bits, stop_bits, timeouts, enabled).
  RPC `wb-mqtt-serial/ports/Load`. Returns only active ports
  from the config, not every physically existing `/dev/ttyRS485-*`.

### Diagnostics
- On a timeout of `wb-mqtt-serial/device/LoadConfig` or `device/Probe`
  the error is now enriched with a hint: "the driver version may be < 2.180,
  check `dpkg -l wb-mqtt-serial`, update via `apt install`". This is not a
  crutch — a real case discovered on A25NDEMJ (wb7) with an outdated
  `wb-mqtt-serial 2.146.0`: these RPC endpoints don't respond, the stable repo
  has 2.224.0+ but the pending update wasn't applied. On a fresh version (2.180+
  on wb8) it works out of the box. The hint is issued only on a timeout,
  ordinary RPC errors (Port is not defined / bad params) pass through as-is.

### Fixed
- **`ssh_exec_async` now appends `-y` to apt install/upgrade/
  dist-upgrade/remove/purge commands** (if `-y`/`--yes`/`--assume-yes` is not set).
  Previously the server only added `DEBIAN_FRONTEND=noninteractive`, and
  a model forgetting `-y` would run, for example, `apt-get install pkg` —
  dpkg waited for Y/N, the default was N, the package wasn't installed. Actually reproduced
  when trying to update wb-mqtt-serial on A25NDEMJ — the package was stuck at
  2.146.0 and `device/LoadConfig` kept not responding. The
  normalization logic is extracted into `src/server/apt-defaults.ts` (with +19 unit tests
  for edge cases: `-y` already present in short/long form, package names
  with `-y` in the name like `python3-yaml`, chained commands, etc.).
  The `controller-update.md` skill is updated with the new rule.

### Tests
- +7 unit tests for `buildLoadConfigParams` (`device_id` priority,
  fallback to `path+slave_id`, null validation, passing optional
  fields, correct handling of `slave_id=0`).
- +4 unit tests for `enrichSerialRpcError` (a timeout in ru/en is recognized,
  the hint about 2.180 is added; non-timeouts pass unchanged; handling of
  non-Error values).

## [0.13.13] — 2026-05-08

### Added
- **`modbus_templates_list`** — a list of Modbus templates via RPC
  `wb-mqtt-serial/config/Load.types`. Without `filter` it returns a summary by
  group (on typical firmware 250+ templates, a flat list would overflow
  the context). With `filter` (a case-insensitive substring over type/mqtt-id/name)
  — a flat list of matches. Templates with `deprecated: true` are marked and counted
  separately.
- **`modbus_template`** — the contents of a single template by `device_type`
  (resolved via Load.types → mqtt-id) or directly by `mqtt_id`. Reads
  `/usr/share/wb-mqtt-serial/templates/config-<mqtt-id>.json`. Views:
  `summary` (default — a compact list of channels with reg_type/address/format/
  type/units), `full` (the whole template), `channels-only`, `meta-only`.
  Optionally filters channels (`enabledOnly`, `channelFilter`).

### Fixed
- **MQTT `connack timeout` on a cold connection**: the `CONNECT_TIMEOUT` limit
  in `MqttPool` raised from 4 s to 8 s. On slow networks / with mDNS resolution
  4 s was not enough for the TCP+MQTT handshake to the controller on the first
  `mqtt_inventory`/`list_devices`/etc. call; from the second time it worked (the connection
  in the cache). 8 s gives headroom, the existing caching keeps subsequent
  calls fast.

### Tests
- +25 unit tests in `tests/modbus-templates.test.ts` for the parsers/formatters:
  `parseTemplatesList` (flattening groups, deprecated, mqtt-id fallback,
  empty), `filterTemplates` (case-insensitive substring over
  type/mqttId/name), `summarizeByGroup` (count/deprecated counts),
  `filterChannels` (enabledOnly + channelFilter), `renderTemplate`
  (4 views with filters, does not mutate the source, gracefully handles
  a missing device).

## [0.13.12] — 2026-05-08

### Fixed
- **Auto-compaction accumulated and didn't fire**: `compactContext()` sent
  the model a soft request "call checkpoint", and if the model ignored it
  (replied with text without a tool call), the `autoCompactTriggeredForRatio` gate
  got stuck, the ratio grew until it flew past the context window — auto-compaction
  no longer tried. Now there are two levels:
  1. **SOFT (≥ autoCompactThreshold, default 0.85)** — the model is asked to
     call `checkpoint(summary=...)`. The prompt is rewritten more firmly: we explicitly
     warn that otherwise at 90% we will truncate the history forcibly
     and tool-results may be lost — its summary is safer.
  2. **HARD (≥ 0.9)** — the backend itself truncates the history in the DB via a new
     endpoint `POST /api/chats/:id/force-compact`: it keeps the system turn
     and the last user message + everything after it; intermediate turns
     are replaced by a single synthetic `[System] 🗜 Forced compaction…`
     notice with a counter of what was dropped. Destructive for tool-results
     — but without it the ratio grows without limit.
  The gate resets on every user `sendMessage` — each new
  request gives auto-compaction a fresh chance.
- **The `autoCompactThreshold` default lowered from 0.85 to 0.70** — 0.85 left
  only 5pp of headroom before HARD compaction (0.9), the model often didn't manage to call
  checkpoint between the soft request and the forced truncation. 0.70 gives 20pp
  for several iterations of "ask → wait → ask again". Existing
  users with a saved `0.85` (or another value) **stay as before**
  — it can be changed via ⚙ Settings or manually in `settings.json`.

### Added
- **A UI indicator `🗜 waiting for checkpoint…`** in the chat header next to the context meter,
  when auto-compaction has sent the model a request but it hasn't yet called checkpoint.
  With a pulse animation, to make it noticeable. The tooltip explains that at 90%
  there will be forced compaction.
- **A background-jobs counter `⏳ N`** in the `ChatInputArea` row next to "Ctrl+J
  — downloaded files". Shown when the model has finished but
  `ssh_exec_async`/`wb_bus_scan`/`serial_debug_collect` are still running on the controller.
  The tooltip suggests checking the status via `job_status`. 0 — the indicator is hidden.

### Tests
- +3 tests in `tests/db-chats.test.ts` for `ChatStore.forceCompact()`:
  truncating middle turns with a synthetic notice; a noop when there is no history
  to compact; preserving the last user-assistant pair on a multi-iteration
  stream.

## [0.13.11] — 2026-05-08

### Added
- **`mqtt_inventory`** — a combined snapshot of MQTT devices in a single call:
  for each `/devices/<id>/`: id, name, driver, error + a list of controls
  with unpacked `meta` (value, type, units, readonly, order, min/max,
  precision, error). Replaces the combo of `list_devices` + N×`list_controls`.
  The `error` field is parsed per the [WB MQTT Conventions](https://github.com/wirenboard/conventions):
  flags `r` (read), `w` (write), `p` (period miss) and combinations. **With
  `error.read=true` the value in the value topic is last-known-good (the last
  successfully read one), not the current live readout** — without knowing this the
  model often makes a wrong diagnosis. Options: `device` (a substring filter),
  `timeout` (1-15 s), `includeEmpty`, `includeMeta` (the raw meta object).
- **`disable_rule`** — disable a wb-rules rule via RPC
  `wbrules/Editor/ChangeState` (under the hood — renaming
  `<name>.js` → `<name>.js.disabled`). Unlike `delete_rule` it is reversible.
  On stable firmware the reverse `enabled:true` via the same RPC returns
  `result:false` (a wb-rules engine limitation) — to enable it back
  you need to manually remove the `.disabled` suffix and reload.

### Tests
- +19 unit tests in `tests/mqtt-inventory.test.ts` for the pure `parseErrorFlags`
  and `buildInventory` — error-flag combinations (r/w/p/rwp + unknown), sorting
  controls by `order`, a device-substring filter, `includeMeta`/`includeEmpty`,
  names with spaces (like `Input 0 counter`), error → last-known-good in
  the errors summary, malformed topics don't break the parser.
- The inventory parser is extracted into a separate module `src/server/mqtt-inventory.ts` —
  to test it without a mock MQTT. The tool handler itself calls
  `MqttPool.listTopics`.

## [0.13.10] — 2026-05-08

### Added
- **`network_status`** — a network summary of the controller in a single call:
  interfaces (`ip -j addr`) with IPv4 addresses and state, the default route
  (`ip -j route`), active NetworkManager connections and devices
  (`nmcli -t -f …`), optionally a ping to a target host. The typical first call
  for diagnosing "no internet" / "the uplink dropped" / "not visible over
  VPN". Closes the 3-4 ssh_exec calls the model used to make manually.
- **`cloud_status`** — the state of the Wiren Board Cloud agent in a single call:
  the activity of the `wb-cloud-agent` service, the presence of a device certificate, the list
  of bound providers, retained MQTT controls (status / activation_link
  / cloud_base_url) for each. With one call you can see whether the
  controller is bound to the cloud and in what state.

### Tests
- +23 unit tests for the pure parsers in `tests/diagnostics-parsers.test.ts`:
  `readMarkedSection`, `parsePingLossPct`, `normalizeInterface`,
  `pickDefaultRoute`, `parseNmcliColons`, `parseCloudMqttControls`. The
  tool handlers themselves (which call ssh.exec) are tested on a live controller;
  the parsers cover all the interesting logic.

## [0.13.9] — 2026-05-08

### Changed
- The tooltip of the 🔧 counter in the footer of an assistant message was reworded: it was
  "The cost next to it includes N tool-calling LLM calls in this reply —
  each iterative call is billed separately", it became "Before this reply
  there were N tool-calling LLM calls — the cost next to it includes them."
  Reads cleaner, conveys the same idea more briefly.

## [0.13.8] — 2026-05-08

### Fixed
- **The footer of assistant messages showed the wrong provider/model/currency**:
  the `provider` / `model` fields were pulled from the current global settings, so
  after switching the provider (e.g. AITunnel ₽ → OpenAI $) past
  messages "moved" — the RUB amount became USD, the brand name changed.
  Now the `turns` table has two new columns `provider`/`model`, which are
  written together with usage on the assistant turn itself; `ChatMessage.vue` takes
  them from there, and legacy records without attribution keep the fallback to current
  settings (as before).
- **`audit.ts`** — section markers via `printf "\n…\n"` instead of `echo`. Files
  cat'd without a trailing `\n` (`/usr/lib/wb-release` ends with
  `REPO_PREFIX=…`) glued the next marker to the last line and
  `splitSections` silently lost the section (`manualPackages` in the audit came back
  empty). Now the marker is always on its own line.
- **`serial_debug_collect`** — rewritten with a trap-protected pattern:
  `python3` instead of fragile sed (idempotent after a crash),
  `trap restore_off EXIT INT TERM` (debug:true doesn't stay alive forever on a
  crash of journalctl/systemctl), `START_TS=$(date -u)` before `sleep` (the window
  no longer shifts retroactively), without `-n 500` (previously it silently truncated
  long captures on a loaded bus).
- **`mqtt_write`** — `writeTopic()` and the tool schema got optional
  parameters `qos` (0/1/2) and `retain`. Previously the hardcoded `{qos: 1, retain: false}`
  prevented publishing retained configs. The defaults are unchanged.
- **An inflated live token sum in the chat header** — `currentChatTokens` sums
  `tokensPrompt` over all assistant turns in `liveTurns`, and each `tool-call`
  during the agent loop pushes a new empty-assistant into `liveTurns`. Onto each
  such empty assistant a cumulative `usage` snapshot was then written, and
  on the intermediate ones stale cumulative values from past iterations remained
  (the same tokens counted multiple times). As a result the chat header
  showed, for example, `$0.29` against `$0.08` in the sidebar and per-message footers
  — the real billing was $0.08, and the header lied. Now the `usage` handler knows
  the boundary of the current stream (`streamStartIdx`) and zeroes the tokens on the intermediate
  assistants of the stream, keeping the cumulative only on the very last one — the sum
  matches the DB.

### Added
- **In the footer of every assistant message — a 🔧 N counter**, how many LLM calls
  with tool-calls there were between the previous reply/user message and
  this reply. With an explanation in the tooltip: "the cost next to it includes N
  tool-calling LLM calls in this reply — each iterative call is
  billed separately". The user sees that $0.05 on the final text includes not
  only text generation but the whole chain of tool iterations of the stream, and doesn't ask
  "where is the cost of the tools".
- **Two new tools in the "System diagnostics" category**:
  - `failed_units` — `systemctl --failed --no-pager`. The first step of "something
    broke" diagnostics — replaces the 2-3 ssh_execs the model made
    before to understand *what* fell over.
  - `systemd_unit { unit, action }` — one tool instead of stitching `is-active`
    / `show` / `status` / `cat` / `list-dependencies`. `action="status"`
    (default) returns a structured object `{active, sub, load,
    unitFileState, exitCode, mainPid, since, statusTail}`. `cat` /
    `list-deps` are read-only. `start`/`stop`/`restart`/`reload`/`enable`/
    `disable`/`mask`/`unmask` — state-changing with the same HITL warning
    as `mqtt_write`/`write_file`. The unit name goes through a whitelist regex before
    the shell; covers services, templated units (`getty@tty1.service`), timers,
    slices and paths.

## [0.13.7] — 2026-05-08

### Fixed
- Regression in v0.13.6: the welcome system_event on chat creation broke two things.
  (1) The chat title was auto-generated from the first user turn, and it turned out to be
  `[System] OpenAI · gpt-5.4-mini · …` — in the chat sidebar and header. Now
  `maybeAutoTitle` skips turns with the `[System]` prefix: the counter and the
  title itself are computed over "real" user messages. (2) In an empty
  chat the suggestion buttons (Overview / Diagnostics / Data) disappeared, because
  the welcome turn made `items.length` non-zero; ChatMessageList now
  considers the chat empty if there is not a single **non-`system_event`** item.

### Note
- v0.13.6 was unpublished due to these regressions — use v0.13.7.

## [0.13.6] — 2026-05-08

### Fixed
- In the compiled binary (linux-x64, windows-x64, AppImage) the system-skill
  fixtures didn't make it inside and `seedSystemSkills` silently exited
  on ENOENT — the `skills` table stayed empty, not a single system skill
  could be loaded via `load_skill`. Now `scripts/build.ts`
  as a separate step generates `embed-skills-manifest.ts` with static
  `import s0 from './fixtures/skills/X.md' with { type: 'text' }`, and Bun
  embeds the contents into the binary as strings. In dev mode `seedSystemSkills`
  still reads from disk. The silent ENOENT return is replaced with
  `console.error` — such a regression will no longer slip away unnoticed. The parametric
  test `tests/skills-parse.test.ts` now runs `extractDescription` on
  every shipping `.md` and catches a skill with an invalid first paragraph before
  a commit.

### Added
- On creating a new chat a ⚙ system_event is immediately written with a summary:
  `Model: <name> · tools: <N> · skills: <M>`. If there are 0 skills — in
  the same line a ⚠ warning about a build bug. The user sees what is loaded,
  before the first message; if the binary lacks embedded fixtures — the problem
  is obvious, not buried in server stderr.

## [0.13.5] — 2026-05-08

### Fixed
- `job_tail` now returns a `state` field (`running` / `exited` /
  `unknown`) and on `running` — also a `_hint`, explicitly telling the model that
  the log is incomplete and it is too early to give a final answer. Previously `job_tail`
  silently returned an empty/partial tail of an unfinished job, and
  the model, seeing "logs empty", drew a false conclusion (e.g.,
  "no updates", when `apt update` hadn't yet finished writing the log). The protection is at the
  tool level, not the system prompt — state is now part of the
  data that cannot be "forgotten".

## [0.13.4] — 2026-05-08

### Added
- **OpenRouter** — the fifth provider (`openrouter.ai/api/v1`, USD billing
  via `usage.cost`). 300+ models including Claude, GPT, Gemini, Llama;
  payment by card or Alipay (can be topped up from Sber/T-Bank).
  In settings: remaining / purchased / spent via `GET /api/openrouter/info`,
  key limits, rate-limit, a free-tier flag.
- **Vision (multi-modal images)** — when sending a user message with
  attached `.png/.jpg/.gif/.webp` the backend converts the tokens
  `[file:id:name]` into `image_url` (data URL + base64). Vision models
  (gpt-4o, gpt-5.4-mini, claude-*) see the image natively. Non-vision
  models return an error from the provider, which `formatLlmError` parses.
- **Archives** (`zip` / `tar` / `tar.gz` / `tgz`) — three new tools
  with auto-detection of the format by magic bytes:
  - `list_archive_contents(fileId)` — listing the files inside.
  - `read_from_archive(fileId, path, encoding)` — reading a single file
    directly (up to 200KB).
  - `extract_archive(fileId, paths?)` — extract all or a subset into
    separate chat attachments. Also works with archives the model
    itself assembled via `fetch_from_controller`.
- **Per-provider rate-limit and retry** — a "Minimum interval between
  requests, ms" field in settings. On 429 the backend makes up to 3 attempts with
  a backoff of 3/8/20s, each attempt written to the chat as a system event
  "⏳ The provider returned 429 (rate limit). Attempt N/3, waiting Xs…".
- **A "Retry" button** in the error banner — retries the request without
  duplicating the user message in the DB (the `retryLast: true` flag).
- **Per-provider `temperature`** — a field in settings, null = the provider's
  default.
- **Previews of attached files** in the chat: a thumbnail for images (opens
  on click in a new tab), a chip with the name + short fileId for
  the rest, an × button on hover to remove from the chat. The fileId is visible in
  the chat — easy to match with what the model reads.
- **Real-time tokens / cost** in the chat header: the `usage` event is emitted after
  each iteration of the agent loop, not only at the end — the counters
  update as the stream goes.
- **Hints about availability from Russia** — a tooltip and a banner under the radio
  button of the provider: AITunnel (without a VPN, payment in ₽), OpenRouter (Alipay,
  top-up from Sber/T-Bank).
- **Tests** for the new features (+19): the archive parser, `pickContextLength`,
  `formatLlmError`.
- **Auto-unloading of skills on `checkpoint`** — after compacting the history all
  loaded skills are unloaded (the model will reload them if needed for the
  next phase). Previously they kept being injected into every turn and
  cluttered the context.
- The system prompt was reinforced in several places:
  - **"Said it — did it in the same turn."** Text like "I'll check now",
    "I'll start with" must be accompanied by a tool_call in the same turn, otherwise
    the stream hangs on a promise.
  - **"Started a background job — finish the turn and wait."** After `ssh_exec_async`
    don't loop `job_status` — 1 check, a short reply to the user, finish the stream.
    The server automatically pings via `[System] The background job
    is done…` when the job → `exited`. This saves tokens and prevents
    giving an answer on a stale cache (`apt list --upgradable` before
    `apt update` finishes).
  - **"Package" in the WB controller context = Debian package (apt/dpkg).**
    Dependencies — via `apt-cache depends`, not via GitHub
    `package.json`.
  - **The description of the `diagrams` skill** is triggered by explicit keywords
    ("diagram", "scheme", "mermaid", "flowchart", "architecture"…), so the
    model loads it on visualization requests.
  - **A nudge after `checkpoint`** — a system message explicitly asks to continue
    the task or give a final answer, not to hang on "I'll check next".

### Changed
- When switching the provider in settings, auto-save is immediate
  (like the API-key auto-save) — otherwise the info endpoints returned 400.
  The settings window does NOT close on auto-save, only on an explicit
  "Save" (a new `autoSaved` event).
- The "Client-side auto-compaction" checkbox is now visible only for providers with
  server-side compaction (AITunnel/OpenRouter). For the rest client-side
  compaction is forced on.
- For AITunnel and OpenRouter there is shared logic: a single checkbox toggles
  the provider's server-side compaction ↔ a client-side checkpoint. The default is server-side.
- Image previews + file chips are pushed to the right (aligned with the
  user message). The copy button for user/assistant — in the top-right
  corner of the bubble, appears on hover, with a backing in the color of the corresponding
  bubble. Previously it looked like a square on top of the text.
- The system prompt was reinforced: with an empty context and a question about ONE
  controller the model is required to clarify which exactly (or confirm "any
  one") — not to pick the first from `list_controllers` by default.

### Fixed
- In the dev build Vite didn't proxy the WebSocket to `/api/ssh/<sn>/shell` —
  the SSH terminal didn't open. `ws: true` in `vite.config.ts`.
- `selectChat` initializes `liveTurns[id]` with a shallow copy of the whole
  history — previously, when sending a new message, persistent history
  could disappear from the UI (live + 2 new turns overtook persisted).
- The chat header (tokens / cost / context %) didn't update after a stream —
  the computeds read `activeChat.turns`, which is no longer recreated
  on in-place merge. Switched to live with a fallback.
- `selectChat` doesn't duplicate the user message when sending via pressing Enter
  at the completion of the previous stream (race fix: `streaming = false`
  is cleared only after a full chat reload).
- `await nextTick()` after the optimistic insert into `liveTurns` — Vue
  is guaranteed to redraw the user message before the stream starts, otherwise on an
  instant model reply the user saw everything at once.
- `runningJobs` updates only on a real change of the job set —
  previously every 3 seconds the array was recreated and Vue re-rendered the groups
  with the running banner.
- `GET /api/chats/:id/jobs` no longer does an SSH `jobStatus` synchronously
  on every UI tick. Job state is updated by a background tracker
  (`startJobTracker` in `jobs.ts`, polling every 5s) — the UI doesn't hang on
  the handshake timeout of an unreachable controller.
- SSH `HANDSHAKE_TIMEOUT` 15s (instead of 4s) + retry with a backoff of 5/10/20s
  only on a handshake timeout. A freshly booted controller no longer
  throws "Timed out while waiting for handshake".
- The chat title is cleaned of `[file:...]` tokens — previously it got straight
  into the chat name.
- The error banner: a ⚠ icon, a bold title, details in small font, clickable
  URLs, "↻ Retry" and "×" buttons to hide it.

### Fixed
- In the dev build (`bun run dev:web` + `bun run dev:server`) the SSH terminal
  didn't open — the Vite proxy didn't pass the WebSocket upgrade to
  `/api/ssh/<sn>/shell`, and xterm.js got a "WebSocket error".
  Added `ws: true` to `vite.config.ts`. In the prod build (one process) the
  bug didn't reproduce — it concerned only the dev environment.
- A regression from 0.13.3: after a stream the persistent chat history could
  "disappear" when sending a new message. `selectChat` initialized
  `liveTurns[id] = []` with an empty stub, then `prevHistory` via `??` took
  the empty array, and the new user message + assistant overwrote the whole
  accumulated feed. Now on selecting a chat `liveTurns[id]` is immediately
  filled with a shallow copy of the whole history (without system) — live becomes
  the single source of truth for rendering, independent of
  `activeChat.turns`.
- The error banner in the chat header became readable: a ⚠ icon, a bold
  title ("Insufficient funds in the provider's account (402)"), details
  in small font, URLs in the text clickable, an "×" button to hide it.
  Previously it was all one long red line.

## [0.13.3] — 2026-05-07

### Fixed
- A message sent with Enter at the moment the model's reply finishes no longer
  "gets lost" and doesn't appear in the wrong place. A race condition in
  `sendMessage` finally: `streaming.value = false` was set BEFORE
  `await api.getChat(id)` + `delete liveTurns[id]`, and the user managed
  to press Enter in that pause — the second `sendMessage` created its own
  `liveTurns[id]`, which was immediately wiped by the old finally.
- A user message could be drawn together with the model's first reply
  (when the model replies instantly). Added `await nextTick()` after
  the optimistic insert into `liveTurns` — Vue is guaranteed to redraw the
  bubble with the user message before the stream reply starts.
- The chat "jittered" periodically in two places:
  - `refreshJobs()` every 3 seconds replaced `runningJobs.value` with a new
    array even if the set didn't change — now the update happens only on a
    real change of job state.
  - After a stream a full `patchLocalChat(c)` was done — `activeChat.value`
    was swapped with a new object, ChatMessageList re-rendered
    markdown/highlight/mermaid. Now only counters + tokens are updated in-place
    on the last assistant turn; live state stays the
    source of truth until switching chats.
- An SSH handshake timeout to a freshly booted controller:
  `Timed out while waiting for handshake`. Previously a single
  `CONNECT_TIMEOUT = 4 s` was used, on armv7 after a reboot the RSA-3072 init
  didn't manage in time. A separate `HANDSHAKE_TIMEOUT = 15 s` was introduced + retry with a backoff
  of 5/10/20 s (only on a handshake timeout, auth errors are not retried).

### Changed
- The input textarea is NOT blocked during the model's reply — the user can
  type the next question. If you press Enter while the model is still writing —
  a soft hint appears under the input field: "The model is still replying.
  Wait for its reply and press Enter again — or press "■ Interrupt", and
  you can send right away." The entered text is preserved.

## [0.13.2] — 2026-05-07

### Fixed
- The background-job banner no longer flickers / disappears during long
  model replies and while the controller is unreachable (e.g., during `apt upgrade`
  with a kernel update and reboot). Two causes:
  1. `GET /api/chats/:id/jobs` called SSH `jobStatus` for each running job
     synchronously. On an unreachable controller the request hung until the handshake timeout
     (~20 s), parallel UI polls overlapped, and sometimes one of them
     returned a stale / inconsistent state — the banner disappeared.
  2. `refreshJobs()` on the UI side, on any error, reset
     `runningJobs = []`, and the banner vanished for 1–2 seconds until the next
     successful poll.

### Changed
- Updating the state of running jobs is moved to a background tracker
  (`startJobTracker` in `jobs.ts`): every 5 seconds the backend polls
  SSH `jobStatus` without blocking the UI endpoint. A transient SSH error
  leaves `state: running` until the next attempt. The UI gets the current
  in-memory state instantly. When a job finishes — the frontend
  on the next tick sees `state: exited` and automatically notifies the model.

## [0.13.1] — 2026-05-07

### Fixed
- When creating a new chat (the "+" button) the context is no longer inherited
  from the current active chat. Previously `newChat()` copied `selectedSns`
  from the open chat, and the SN "stuck" — after a restart it looked like
  the app had picked a controller itself. Every new chat now starts
  with an empty context.

## [0.13.0] — 2026-05-07

### Added
- **AITunnel** — a new provider (api.aitunnel.ru/v1, RUB billing via
  `usage.cost_rub`). Balance / 30-day stats / email right in
  settings via `GET /api/aitunnel/info`; a "will last N days" forecast
  and a red highlight when days < 3.
- **Per-provider context**: `contextWindow`, `compactModel`, `autoCompact`,
  `autoCompactThreshold`, `temperature` are now each provider's own.
- **Auto-detection of the context window** from `/v1/models` (fields
  `context_length` / `context_window` / `top_provider.context_length` /
  `max_input_tokens` — covers OpenRouter, LiteLLM, Ollama-compat).
- **Context auto-compaction**: a client-side watch on the fill ratio with
  a configurable threshold; on exceeding it automatically sends a `checkpoint`,
  optionally via a separate (cheaper) `compactModel`.
- **Readable provider errors** — `formatLlmError()` parses the
  AITunnel structure `{error: {code, message, metadata}}` and the standard OpenAI shape:
  401 "invalid key", 402 "insufficient funds", 403 "moderation"
  (with reasons / flagged_input / provider_name), 408/429/502.
- **API-key auto-save** on input (debounce 600 ms).
- **`temperature`** as an optional per-provider field (empty = the provider's
  default).

### Changed
- The checkpoint stream now uses `compactModel` (if set) only for
  a single call — the main model is not swapped.
- The context progress bar and the "📦 compact" button in the chat header are hidden when
  `autoCompact` is off (for AITunnel — by default).
- `ssh_exec` filters the stderr noise `WARNING: apt does not have a stable
  CLI interface...`; for `apt list --upgradable` without a fresh `apt-get
  update` it suggests refreshing the cache and loading the `controller-update` skill.

[Unreleased]: https://github.com/wirenboard/wb-ai-helper-desktop/compare/v0.13.22...HEAD
[0.13.22]: https://github.com/wirenboard/wb-ai-helper-desktop/compare/v0.13.21...v0.13.22
[0.13.21]: https://github.com/wirenboard/wb-ai-helper-desktop/compare/v0.13.20...v0.13.21
[0.13.20]: https://github.com/wirenboard/wb-ai-helper-desktop/compare/v0.13.19...v0.13.20
[0.13.19]: https://github.com/wirenboard/wb-ai-helper-desktop/compare/v0.13.18...v0.13.19
[0.13.18]: https://github.com/wirenboard/wb-ai-helper-desktop/compare/v0.13.17...v0.13.18
[0.13.17]: https://github.com/wirenboard/wb-ai-helper-desktop/compare/v0.13.16...v0.13.17
[0.13.16]: https://github.com/wirenboard/wb-ai-helper-desktop/compare/v0.13.15...v0.13.16
[0.13.15]: https://github.com/wirenboard/wb-ai-helper-desktop/compare/v0.13.14...v0.13.15
[0.13.14]: https://github.com/wirenboard/wb-ai-helper-desktop/compare/v0.13.13...v0.13.14
[0.13.13]: https://github.com/wirenboard/wb-ai-helper-desktop/compare/v0.13.12...v0.13.13
[0.13.12]: https://github.com/wirenboard/wb-ai-helper-desktop/compare/v0.13.11...v0.13.12
[0.13.11]: https://github.com/wirenboard/wb-ai-helper-desktop/compare/v0.13.10...v0.13.11
[0.13.10]: https://github.com/wirenboard/wb-ai-helper-desktop/compare/v0.13.9...v0.13.10
[0.13.9]: https://github.com/wirenboard/wb-ai-helper-desktop/compare/v0.13.8...v0.13.9
[0.13.8]: https://github.com/wirenboard/wb-ai-helper-desktop/compare/v0.13.7...v0.13.8
[0.13.7]: https://github.com/wirenboard/wb-ai-helper-desktop/compare/v0.13.6...v0.13.7
[0.13.6]: https://github.com/wirenboard/wb-ai-helper-desktop/compare/v0.13.5...v0.13.6
[0.13.5]: https://github.com/wirenboard/wb-ai-helper-desktop/compare/v0.13.4...v0.13.5
[0.13.4]: https://github.com/wirenboard/wb-ai-helper-desktop/compare/v0.13.3...v0.13.4
[0.13.3]: https://github.com/wirenboard/wb-ai-helper-desktop/compare/v0.13.2...v0.13.3
[0.13.2]: https://github.com/wirenboard/wb-ai-helper-desktop/compare/v0.13.1...v0.13.2
[0.13.1]: https://github.com/wirenboard/wb-ai-helper-desktop/compare/v0.13.0...v0.13.1
[0.13.0]: https://github.com/wirenboard/wb-ai-helper-desktop/compare/v0.12.1...v0.13.0
