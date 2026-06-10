# documentation-search

Searching the Wiren Board documentation — source order (wiki → GitHub → web_search), direct `web_fetch` without googling, working around CAPTCHA. Load this when the user asks "read the docs/wiki/README", or when you yourself are unsure of the syntax / a topic name / an RPC method / a template field.

Don't reach for the internet at every turn: if the answer is on the controller (`device/LoadConfig`, `dpkg -l`, a local file) — go there, not to the docs.

## Wiki directly via web_fetch, not via web_search

`web_search` is the last resort. Guessed the URL — go straight to `web_fetch`. Didn't guess — `web_fetch` the search on the wiki itself. Only if that's empty too — `web_search`. Better one extra `web_fetch` than a confident wrong answer.

## Sources

### 1. Wiki — the main one

Base URL: `https://wirenboard.com/wiki/<Page>`. Page names are `Snake_Case`/`CamelCase`, spaces → `_`. It redirects to `wiki.wirenboard.com` — it's the same site.

- Module: `web_fetch('https://wirenboard.com/wiki/WB-MR6C')`, `WB-MSW_v.4`, `WB-MAP12E`.
- Topic: `Wb-rules`, `Rule_Examples`, `MQTT_Devices_and_Controls`, `How_to_diagnose`.
- Wiki search (if you don't know the exact URL): `web_fetch('https://wirenboard.com/wiki/Special:Search?search=<query>')`.

### 2. GitHub — sources, templates, README

Base URL: `https://github.com/wirenboard/<repo>/...`.

- README: `web_fetch('https://github.com/wirenboard/wb-rules/blob/master/README.md')`.
- Raw file (no HTML wrapper, more compact): `web_fetch('https://raw.githubusercontent.com/wirenboard/wb-mqtt-serial/main/templates/config-wb-mr6c.json')`.
- Directory listing: `web_fetch('https://github.com/wirenboard/wb-mqtt-serial/tree/main/templates')`.

`web_fetch` truncates at 64KB — for large pages, read them in parts via a more specific URL.

### 3. web_search — when the wiki and GitHub didn't help

Limit: **3 calls** per model response, reset on a new user message.

1. `web_search('<query>')` → take a URL from the top.
2. `web_fetch('<URL>')` → read it.

If the first `web_search` returned 0 results — **don't rephrase**, switch to `web_fetch` directly (even to a guessed URL). Rephrasing almost never helps.

## Brave CAPTCHA

`web_search` sometimes returns a CAPTCHA / rate-limit. In that case the budget is reset, don't fire new calls. Go to `https://wirenboard.com/wiki/Special:Search?search=<query>` via `web_fetch` — that's a search on the wiki itself, without third-party engines.

## Pitfalls

- Going straight to `web_search` instead of `web_fetch` on the wiki — you burn the limit and get irrelevant results.
- Pulling device templates from GitHub — on the controller the up-to-date template for the firmware is available via `mqtt_rpc(sn, "wb-mqtt-serial", "device", "LoadConfig", ...)` (see the `wb-mqtt-serial` skill).
- `github.com/.../blob/...` for reading code — that's an HTML wrapper. For raw content use `raw.githubusercontent.com/...`.
- Repeating `web_search` with a rephrasing — change the strategy (a different source, a direct URL), not the wording.

## Documentation

- Wiren Board Wiki: <https://wirenboard.com/wiki/>
- Wiren Board GitHub: <https://github.com/wirenboard>
