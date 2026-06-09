# wb-rules

The Wiren Board rules engine. Scripts live in `/etc/wb-rules/*.js`, reusable modules in `/etc/wb-rules-modules/*.js`. The language is **ES5** (no `let`/`const`/arrow functions) plus WB-specific syntactic sugar. Rules are edited via the RPC `wbrules/Editor/*`, modules — via `write_file`. Load on "make it so that…", "when X — do Y", on timer/event/button/motion, when editing in `/etc/wb-rules/`, when `defineRule` or virtual devices are mentioned.

The canonical documentation is the repository README <https://github.com/wirenboard/wb-rules> (the wiki is only a navigation page). If in doubt about the syntax — `web_fetch` the README, don't guess.

## Workflow: writing a rule

1. **Find out the control type** before writing: `mqtt_read(sn, "/devices/<d>/controls/<c>/meta/type")`.

2. **Check for conflicts with existing rules** — a mandatory step before writing code:
   - `mqtt_rpc(sn, "wbrules", "Editor", "List", {})` → find files that might use the same controls
   - `mqtt_rpc(sn, "wbrules", "Editor", "Load", {path})` for each — read the logic
   - **Explain to the user in words and tables** how the new rule will interact with the existing ones. Engineers aren't afraid of code — offer to show it if needed, but first a state table or a diagram:

   ```
   Input A (button) | Sensor B (leak)  | Expected   | Actual       | Status
   ────────────────────────────────────────────────────────────────────────────
   OFF → ON         | inactive         | relay on   | relay on     | ✓ OK
   OFF → ON         | active           | relay off  | relay on     | ✗ CONFLICT
   ON → OFF         | active           | relay off  | relay off    | ✓ OK
   ```

   If there are no conflicts — briefly describe how the two rules work together and in which cases which one takes precedence.
   Get confirmation before saving if there are conflicts or non-trivial interaction.

3. **Show the logic of the new rule** — before the code:
   - For simple logic — an "input → output" table
   - For branches, states, chains — a Mermaid diagram (`flowchart TD`, `stateDiagram-v2`, `sequenceDiagram`)
   - Ask "is this the intended behavior?" and wait for confirmation

   Example:
   ````
   ```mermaid
   flowchart TD
       A[IN1 changed] --> B{Leak active?}
       B -- yes --> C[Valve closed, notification]
       B -- no --> D{Button on?}
       D -- yes --> E[Open valve]
       D -- no --> F[Close valve]
   ```
   ````

4. **Write the rule** with the correct value types (see below).
5. **Save via RPC**:
   ```
   mqtt_rpc(sn, "wbrules", "Editor", "Save", {path: "name.js", content: "..."})
   ```
6. **Check the logs immediately after Save**:
   ```
   ssh_exec(sn, "journalctl -u wb-rules --since '10 seconds ago' --no-pager")
   ```
   Look for `can't convert`, `SyntaxError`, `TypeError`, `ReferenceError`. If present — fix and re-save. Don't wait for the user to complain.

All operations on `/etc/wb-rules/*.js` files go through the specialized tools. Do **NOT** use `write_file` + `systemctl restart wb-rules` for rules — the wrappers validate the JS and reload the engine themselves.

- `list_rules(sn)` — list of rules with enabled/disabled status
- `load_rule(sn, name)` — read the contents (name without `.js`)
- `save_rule(sn, name, content)` — create/update (name without `.js`)
- `delete_rule(sn, name)` — delete, with an automatic ssh fallback on cache desync

Names everywhere without the path prefix and without the extension: `wb-la-temp-relay`, not `wb-la-temp-relay.js` and not `/etc/wb-rules/...`.

**Disable a rule without deleting it** — `load_rule` → add `return; // wb-la-disabled` as the first line inside each `then: function(...) {` → `save_rule`. To re-enable — remove that line, save.

**Before disabling a file with multiple rules — warn.** If the user asked to disable one rule but the file contains several — say so explicitly and get confirmation. For example: "The file `wb-la-kran-protect.js` contains two rules: `wb-la-kran-toggle` and `wb-la-kran-leak`. Disabling the whole file — both will stop working. Continue?"

**Delete a rule only with explicit user confirmation.** Never call `delete_rule` without a separate "yes, delete it".

For `/etc/wb-rules-modules/*.js` there is no RPC — write them with the regular `write_file`, the engine will pick them up on its own.

## ES5 and limitations

- **var**, regular `function`. No `let`, `const`, arrow functions, template strings, destructuring, `class`, `async/await`.
- **In JS code, only ASCII operators**: `≤`→`<=`, `≥`→`>=`, `≠`→`!=`, `×`→`*`, `÷`→`/`. Unicode characters will cause a SyntaxError in Duktape.
- Side effects in a `when` / `asSoonAs` / `whenChanged` function are not allowed — the engine calls them unpredictably.
- The working way to share state between rules: `PersistentStorage({global: true})` or a module (`module.static`). Plain globals do **not** cross files.

## Control types and values

The value in `dev[...]` is coerced to a native JS type based on the control's `meta/type`:

| type | JS type of the value |
|---|---|
| `switch`, `alarm` | `boolean` (`true`/`false`) |
| `value`, `range`, `temperature`, `power`, `voltage`, `current`, `pressure` | `number` |
| `text` | `string` |
| `pushbutton` | fires as an event (button), the value is a `number` (press counter) |
| `rgb` | `string` of the form `"R;G;B"` |
| unknown | `string` |

**The most common mistake — `switch = 1` instead of `true`:**

```js
dev["wb-mwac_25/K1"] = true;    // ✓ switch
dev["wb-mr6c_7/K1"] = false;    // ✓ switch
dev["wb-mwac_25/K1"] = 1;       // ✗ log: can't convert control value '1' (type float64) to datatype '1'
```

Reading an uninitialized control — `undefined`. For meta — `null` if the control/device does not exist:

```js
if (dev["d/c"] === undefined) return;   // the control exists, but the value hasn't arrived yet
if (dev["d/c#error"] === null) ...      // the control/device doesn't exist at all
```

## Accessing controls

Three equivalent forms (from the README):

```js
dev["device/control"]   // canonical, always works
dev["device"]["control"]
dev.device.control
```

The only hard rule: **names with spaces, Cyrillic, hyphens, and leading digits — only via bracket notation**:

```js
dev["wb-msw-v4_20/Temperature"]             // ok
dev["wb-msw-v4_20"]["Temperature"]          // ok
dev.wb-msw-v4_20.Temperature                // ✗ SyntaxError (minus)
dev["hwmon"]["CPU Temperature"]             // ok (space)
dev.hwmon.CPU Temperature                   // ✗ SyntaxError (space)
```

`dev["d/c"]` — always a safe choice, use it by default.

### Accessing meta

After `#` — a meta field:

```js
dev["wb-mr3_48/K1#error"]       // read /meta/error
dev["wb-mr3_48/K1#readonly"]
dev["virDev/cell#max"] = 255    // write max for a virtual device
```

It can also be used as a trigger — see `asSoonAs` and `whenChanged` below.

## defineRule: four trigger types

```js
defineRule(name, {
  <trigger>: ...,
  then: function (newValue, devName, cellName) { ... }
});
```

`then` always gets 3 arguments, all `undefined` if the rule was triggered by something other than a control change.

### 1. `whenChanged` — on control change (recommended)

Fires when the listed controls change or at engine startup, if there's a retained value in MQTT.

```js
defineRule("light_toggle", {
  whenChanged: "wb-mcm8_16/Input 1",
  then: function (newValue, devName, cellName) {
    if (newValue) dev["wb-mr6c_7/K1"] = !dev["wb-mr6c_7/K1"];
  }
});

// Multiple controls:
defineRule("any_light", {
  whenChanged: ["wb-gpio/A1_OUT", "wb-gpio/A2_OUT"],
  then: function (newValue, devName, cellName) {
    log("{}/{} = {}", devName, cellName, newValue);
  }
});

// Computed trigger: fires when the expression changes its result
defineRule("threshold", {
  whenChanged: [
    "wb-msw-v4_20/Temperature",
    function () { return dev["wb-msw-v4_20/Temperature"] > 25; }
  ],
  then: function (newValue) { log("over 25: {}", newValue); }
});
```

Works with `pushbutton` — fires on every press.

### 2. `asSoonAs` — on the condition's rising edge (0→1)

Fires when the condition function transitions `false → true`. Does not fire again until it goes back to `false` and to `true` once more.

```js
defineRule("overheat_start", {
  asSoonAs: function () {
    return dev["wb-msw-v4_20/Temperature"] > 40;
  },
  then: function () { dev["wb-mr6c_7/K2"] = true; }
});
```

### 3. `when` — on a condition (level-triggered)

Called every time the engine re-evaluates the rules and the condition is true. Usually you want `asSoonAs` or `whenChanged` — `when` is rarely optimal.

```js
defineRule("while_hot", {
  when: function () { return dev["wb-msw-v4_20/Temperature"] > 40; },
  then: function () { log("still hot"); }
});
```

### 4. `when: cron(...)` — on a schedule

⚠️ **Cron in wb-rules is 6-field, the first field is SECONDS. This is NOT standard Linux cron (5 fields).** The most common mistake is to write `"0 * * * 5"` expecting "on Fridays"; in reality it's parsed as `sec=0 min=* hour=* dom=* mon=5` (every minute in May).

Syntax of [robfig/cron/v3](https://pkg.go.dev/github.com/robfig/cron/v3): `<sec> <min> <hour> <dom> <mon> [<dow>]` (the last is optional). The aliases `@hourly`, `@daily`, `@weekly`, `@monthly`, `@yearly` are supported, as well as `@every <dur>` (e.g. `@every 30s`, `@every 5m`).

Comparison with system cron:

| Task | Linux cron (`/etc/cron.d`) | wb-rules `cron(...)` |
|---|---|---|
| daily at 20:00 | `0 20 * * *` | `0 0 20 * * *` |
| every Friday at 08:00 | `0 8 * * 5` | `0 0 8 * * 5` |
| every 30 sec | — | `@every 30s` |
| every minute | `* * * * *` | `0 * * * * *` |

If you see a 5-field string in the code — it's **almost certainly a bug**: prepend a leading `0 ` for the seconds.

```js
defineRule("night_light_off", {
  when: cron("0 0 23 * * *"),        // every day at 23:00
  then: function () { dev["wb-mr6c_7/K1"] = false; }
});

defineRule("check_temp", {
  when: cron("@every 30s"),
  then: function () { /* ... */ }
});

defineRule("heartbeat", {
  when: cron("@hourly"),
  then: function () { log("heartbeat"); }
});

defineRule("friday_report", {
  when: cron("0 0 8 * * 5"),         // every Friday at 08:00
  then: function () { /* ... */ }
});
```

Cron survives an engine reload.

## Timers

### setTimeout / setInterval (regular JS)

```js
var id = setTimeout(function () { ... }, 2000);
clearTimeout(id);

var tickId = setInterval(function () { ... }, 500);
clearInterval(tickId);
```

**`setInterval` works normally** (it's plain ES5). The minimum is 1 ms, but don't set it below 10 ms — CPU.

Example "blinker for 10 firings":

```js
var test_interval;
defineRule("blink", {
  whenChanged: "test/enabled",
  then: function (newValue) {
    if (!newValue) return;
    var n = 0;
    test_interval = setInterval(function () {
      dev["buzzer/enabled"] = !dev["buzzer/enabled"];
      if (++n >= 10) clearInterval(test_interval);
    }, 500);
  }
});
```

### startTimer / startTicker (WB-specific, integrated with the rules)

The timers are named, accessed via `timers.<name>`. A timer firing is an event that can be a `when` trigger.

```js
defineRule("pulse_start", {
  asSoonAs: function () { return dev["test/enabled"]; },
  then: function () { startTimer("pulse", 1000); }  // single-shot
});

defineRule("pulse_fire", {
  when: function () { return timers.pulse.firing; },
  then: function () {
    dev["buzzer/enabled"] = false;
  }
});

// Ticker — the same, but repeating
startTicker("heartbeat", 5000);
timers.heartbeat.stop();   // stop it
```

`setTimeout/setInterval` — simpler; `startTimer/startTicker` — when you need integration with `when: timers.X.firing`.

## defineVirtualDevice

Creates the MQTT topics `/devices/<id>/controls/<cell>`, visible in the UI and accessible via `dev[]`.

```js
defineVirtualDevice("my_vd", {
  title: {en: "My VD", ru: "Моё устройство"},
  cells: {
    power: {
      type: "switch",
      value: false
    },
    setpoint: {
      type: "range",
      value: 22,
      min: 10,
      max: 30,
      units: "°C",
      order: 2
    },
    mode: {
      title: {en: "Mode", ru: "Режим"},
      type: "value",
      value: 1,
      enum: {
        1: {en: "Auto", ru: "Авто"},
        2: {en: "Manual", ru: "Ручной"}
      }
    },
    last_update: {
      type: "text",
      value: "",
      readonly: true
    }
  }
});
```

**cell properties:**

| Field | Purpose |
|---|---|
| `title` | a string or `{en, ru}` |
| `type` | see the types above |
| `value` | default on first start |
| `units` | unit of measurement, published to `/meta/units` |
| `min`, `max` | for `value`/`range` |
| `precision` | number of decimal places |
| `readonly` | `true` — read-only; defaults to true for most, false for `switch`/`pushbutton`/`range`/`rgb` |
| `order` | display order in the UI |
| `enum` | a "value → {en, ru}" dictionary for textual display |
| `forceDefault` | `true` — reset to `value` on every restart (defaults to false) |
| `lazyInit` | `true` — don't publish until the first write |

## Logging

```js
log(fmt, ...)          // info
log.info(fmt, ...)
log.debug(fmt, ...)    // visible only with WB_RULES_OPTIONS="-debug"
log.warning(fmt, ...)
log.error(fmt, ...)
debug(fmt, ...)        // alias for log.debug
```

Written to syslog (`journalctl -u wb-rules`) and to the MQTT topics `/wbrules/log/<level>`.

Formatting:
- `"{}"` — placeholder, `log("a={} b={}", "q", 42)` → `"a=q b=42"`
- `"{{"` — a literal `{`
- `.xformat(...)` — like format, plus `{{expr}}` for arbitrary JS expressions: `"Value: {{dev['abc/def']}}"`.

## MQTT operations

### publish — arbitrary topics

```js
publish(topic, payload)                   // QoS 0, not retained
publish(topic, payload, 2)                // QoS 2
publish(topic, payload, 2, true)          // retained
```

⚠️ For device parameters use `dev[...] = ...` — it publishes with the correct QoS/retained itself. `publish()` is only for topics outside the device model.

### trackMqtt — subscribe to any topic

```js
trackMqtt("/devices/wb-adc/controls/Vin", function (msg) {
  // msg = {topic: "...", value: "..."}
  log.info("{}={}", msg.topic, msg.value);
});
```

## Shell commands

```js
runShellCommand("uname -a", {
  captureOutput: true,
  captureErrorOutput: true,
  input: "stdin text",
  exitCallback: function (code, stdout, stderr) {
    if (code === 0) log("out: {}", stdout);
  }
});

// equivalent: spawn("/bin/sh", ["-c", cmd], opts)
spawn("/usr/bin/ls", ["-la", "/etc/wb-rules"], {
  captureOutput: true,
  exitCallback: function (code, out) { log(out); }
});
```

## Managing rules

```js
var myRule = defineRule("name", { whenChanged: "...", then: ... });
disableRule(myRule);    // stop checking it
enableRule(myRule);     // turn it back on
runRule(myRule);        // force-run then
```

## Device/Control API

```js
getDevice("wb-mr6c_7")                         // device object
getControl("wb-mr6c_7/K1")                     // control object
isControlExists("wb-mr6c_7/K1")                // bool

// device methods:
getDevice(d).getId()
getDevice(d).controlsList()                    // array of all controls
getDevice(d).addControl(id, spec)              // virtual only
getDevice(d).removeControl(id)
getDevice(d).isVirtual()
getDevice(d).setError(str) / .getError()

// control methods:
getControl(dc).getValue() / .setValue(v)
getControl(dc).setTitle(str) / .setDescription(str)
getControl(dc).setType(str)
getControl(dc).setUnits(str)
getControl(dc).setMin(n) / .setMax(n) / .setPrecision(n)
getControl(dc).setReadonly(b)
getControl(dc).setError(str) / .getError()
getControl(dc).setValue({value: v, notify: false})  // write without publishing
```

## Configs and aliases

```js
var cfg = readConfig("/etc/myscript.conf");   // JSON with // and /* */ comments
// Wrap arrays: readConfig("x.conf").config

defineAlias("heater", "Relays/Relay 1");
heater = true;    // == dev["Relays/Relay 1"] = true
```

## PersistentStorage

Survives an engine and controller restart. `{global: true}` — mandatory.

```js
var ps = new PersistentStorage("my_state", {global: true});
ps["count"] = (ps["count"] || 0) + 1;
ps["last_ts"] = Date.now();

// Objects — only via StorableObject:
ps["cfg"] = new StorableObject({temperature: 21, enabled: true});
ps["cfg"].temperature = 23;   // will be saved

// Deletion:
ps["count"] = null;
```

## Modules

```js
// /etc/wb-rules-modules/utils.js
exports.celsiusToF = function (c) { return c * 9 / 5 + 32; };
exports.const_pi = 3.14159;
// module.static — shared storage between all rules that require the module

// In a rule:
var utils = require("utils");
log("{}", utils.celsiusToF(25));
```

Don't reassign `exports`, only add properties.

## Alarms and notifications

```js
Notify.sendEmail("x@y.ru", "subj", "body");
Notify.sendSMS("+7...", "body");
Notify.sendTelegramMessage(token, chatId, "body");

Alarms.load("/etc/wb-rules/alarms.conf");   // or an object with the spec
```

The full `alarms.conf` specification is in the README.

## Full example

```js
defineVirtualDevice("climate", {
  title: {en: "Climate", ru: "Климат"},
  cells: {
    enabled: { type: "switch", value: false },
    setpoint: { type: "range", value: 22, min: 15, max: 30, units: "°C" },
    current:  { type: "temperature", value: 0, readonly: true }
  }
});

defineRule("climate_sync", {
  whenChanged: "wb-msw-v4_20/Temperature",
  then: function (newValue) {
    dev["climate/current"] = newValue;
  }
});

defineRule("climate_control", {
  whenChanged: ["climate/enabled", "climate/current", "climate/setpoint"],
  then: function () {
    if (!dev["climate/enabled"]) {
      dev["wb-mr6c_7/K1"] = false;
      return;
    }
    var hyst = 0.5;
    var cur = dev["climate/current"];
    var sp  = dev["climate/setpoint"];
    if (cur < sp - hyst) dev["wb-mr6c_7/K1"] = true;
    else if (cur > sp + hyst) dev["wb-mr6c_7/K1"] = false;
  }
});

defineRule("climate_morning", {
  when: cron("0 0 7 * * *"),
  then: function () { dev["climate/enabled"] = true; }
});
```

## Conventions

- File: `wb-la-<slug>.js` (hyphens, Latin), header `// wb-la: description in Russian`
- Rule name in `defineRule`: `wb-la-<slug>` (matches the file name without `.js`)
- **In replies to the user:** the script file and the rules inside it are different entities, always distinguish them visually:
  - File: marker `📄`, always with `.js` → `📄 wb-la-kran-protect.js`
  - Rule from `defineRule`: marker `⚙`, without `.js` → `⚙ wb-la-kran-toggle`
  - When listing — a nested structure: the file at the top, the rules inside it, indented

## Pitfalls

- **switch = true/false, NOT 0/1.** wb-rules returns a native boolean — `newValue` is already `true`/`false`, don't write `=== 1 || === "1" || === true` and the like, it's junk.
- **Didn't check the logs after Save** — `journalctl -u wb-rules --since '10s ago'`. Without this, errors are silently ignored.
- **`whenChanged` on its own output** — an infinite loop. Set a flag or separate in/out.
- **Side effects in `when`/`asSoonAs`/whenChanged-function** — the engine calls them unpredictably. Pure logic only.
- **`let`/`const`/arrow** — SyntaxError, ES5 only.
- **Names with spaces via the dot** — SyntaxError, only `dev["d/c"]` or `dev["d"]["c"]`.
- **`dev` outside a rule / outside `then` / `setTimeout` callback** — an assignment ALWAYS publishes to MQTT, even if the value didn't change. At the script's top level this breaks the logic.
- **Publishing > 100 topics/sec** — high CPU, degradation. Optimize the frequency.
- **Global variables between files** do not cross over. Use modules or `PersistentStorage({global: true})`.
- **`ps["obj"].foo = 5`** without `StorableObject` — won't be saved. Wrap objects in `new StorableObject({...})`.
- **`whenChanged` control overrides `asSoonAs` protection** — if a protection rule (`asSoonAs`) closes a valve/relay on a fault, while a control rule (`whenChanged` button) opens it back — it will fire even when the fault sensor is still active: `asSoonAs` does not repeat until the condition resets. In the `then` of the control rule always check the blocking sensor: `if (dev["sensor/alarm"]) return;`
- **String concatenation without a space** — `"journalctl -u" + unit` gives `"journalctl -uwb-rules"`. Put the space inside the string: `"journalctl -u " + unit`.

## Documentation

- README (the canonical reference): <https://github.com/wirenboard/wb-rules>
- Examples: <https://github.com/wirenboard/wb-rules/tree/master/examples>
- Navigation on the wiki: <https://wirenboard.com/wiki/Wb-rules>
- Cron syntax (`robfig/cron/v3`): <https://pkg.go.dev/github.com/robfig/cron/v3>
