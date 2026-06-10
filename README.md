# WB AI Helper — desktop AI assistant for Wiren Board

> **Prototype / experimental project.**
> An early version for internal testing, not ready for use in critical production environments.
> The tool has direct access to controllers over MQTT and SSH — including writing topics, running arbitrary commands and background jobs via `systemd-run`. Use it deliberately and at your own risk.

![Main window](docs/screenshots/main.png)

A single binary for Linux / Windows + an AppImage for the Linux desktop. Download → run → an embedded Chrome window opens with the chat and a list of controllers discovered on the local network via mDNS (`wirenboard-<SN>.local`). LLM keys, MQTT and SSH credentials are set in the UI and stored in `~/.config/wb-ai-helper/` (or next to the binary in standalone mode).

## Quick start

1. **Download the build for your OS** from [Releases](../../releases/latest):
   - Linux desktop: `WB-AI-Helper-x86_64.AppImage` (all-in-one with UI)
   - Linux CLI / server: `wb-ai-helper-linux-x64`
   - Windows: `wb-ai-helper-windows-x64.exe`
2. **Get an API key** from any OpenAI-compatible provider:
   - **OpenAI** — [platform.openai.com/api-keys](https://platform.openai.com/api-keys); top up the balance with a credit card. Recommended model — `gpt-4.1` or `gpt-5.4-mini`
   - **AITunnel** — [aitunnel.ru](https://aitunnel.ru/) (reachable from Russia without a VPN, RUB billing, payment by a Russian card, 200+ models including Claude/GPT/Gemini)
   - **OpenRouter** — [openrouter.ai](https://openrouter.ai/) (300+ models; payment by card or via Alipay, which can be topped up from Sber or T-Bank)
   - **Self-hosted** — Ollama / LiteLLM / vLLM on your own server, key optional
   - **Corporate / MITM proxy** — see the [Custom AI Proxy](#custom-ai-proxy) section below
3. **Run and configure:**
   - `chmod +x ./WB-AI-Helper-x86_64.AppImage && ./WB-AI-Helper-x86_64.AppImage`
   - Open «Settings» (⚙) in the header
   - Pick a provider → paste the key → click «refresh list» → pick a model → «Save»
4. Controllers in the right column appear automatically via mDNS. If mDNS is blocked on your network — add one manually by hostname/IP.
5. The chat is live. For example: «what is connected on the RS-485 bus?», «send me a chart of CPU temperature since yesterday».

### What to download?

| File | OS | Description |
|------|----|-------------|
| `WB-AI-Helper-x86_64.AppImage` | Linux | All-in-one: server + auto-launch of Chrome in app mode (no address bar). If Chrome/Chromium is not installed — opens the UI in the default browser via `xdg-open` |
| `wb-ai-helper-linux-x64` | Linux | Standalone CLI/server. Serves HTTP on port 17321, opens the browser. Suitable for headless use or when the AppImage is not needed |
| `wb-ai-helper-windows-x64.exe` | Windows | Standalone server. Serves HTTP on port 17321 and opens the browser |

## What it can do

**Discovery and controller operations:**
- **mDNS network scanner** — automatically finds controllers matching the `wirenboard-<SN>.local` pattern. The list refreshes every ~15 seconds. If mDNS is blocked on the network, a controller can be added manually by hostname or IP
- **Controller Web UI** — clicking 🌐 on a card opens the controller's web interface in a new tab
- **Built-in SSH terminal** — clicking ▷_ opens a bottom sheet with xterm.js over an ssh2 session. Hotkeys, colors, ANSI escapes — everything works
- Multiple chats in parallel, each with its own controller context (one / a selected group / all)

**LLM with tool-calling:**
- 5 provider profiles: **OpenAI** (direct access), **AITunnel** (RUB billing, balance/stats right in settings), **OpenRouter** (USD, key balance/limits in settings, 300+ models, context auto-detection from `/v1/models`), **Custom** (Ollama, LiteLLM, vLLM…), **Custom AI Proxy** (MITM proxy with a CA certificate). Each keeps its own key/baseURL/model/proxy/CA/temperature/contextWindow/auto-compaction — switched instantly
- Per-provider context-window control: auto-detection from `/v1/models` (for providers like OpenRouter), a manual override, an optional separate (cheaper) model for checkpoints, auto-compaction when the window fills past a configurable threshold
- ~50 tools: `mqtt_*`, `ssh_*`, `wb_bus_scan`, `serial_debug_collect`, `audit_controller`, `get_history`/`get_history_chart` (charts via vega-lite — line/bar/area/point/histogram/heatmap/boxplot), `fetch_from_controller`/`upload_to_controller`, `save_rule`/`load_rule`/`delete_rule` (wb-rules via `wbrules/Editor`)
- 17 skills (`controller-backup`, `controller-update`, `wb-mqtt-serial`, `wb-rules`, `troubleshooting-*`, `diagrams`, `history` and others) — loaded on demand via `load_skill`
- Background jobs (`ssh_exec_async`, `wb_bus_scan`, `serial_debug_collect`) — launched via `systemd-run` on the controller, with an inline indicator in the chat and a 5-second undo to cancel
- Attachments: user uploads (via 📎) and model-produced files (`fetch_from_controller`/`get_history_chart`) are separated by source — the model does not receive its own files back
- Per-message cost (USD per 1M tokens for OpenAI, server-side cost in RUB for AITunnel/VseGPT via `usage.cost_rub`/`total_cost`)
- Readable provider errors: 401 «invalid key», 402 «insufficient funds», 403 «moderation» (with reasons/snippet), 408/429/502 — without a raw stack trace

**UI/UX:**
- Collapsible side panels (chats on the left, controllers on the right)
- Model search (typeahead)
- Chat deletion + «delete all» with a 5-second undo
- Export/import settings as JSON (including keys and CA)
- Dark/light/auto theme, font-size adjustment

## Where data is stored

| Mode | Path |
|------|------|
| AppImage / dev | `~/.config/wb-ai-helper/` (Linux/XDG) |
| Standalone binary | next to the binary |

Files: `settings.json`, `wb-ai-helper.db` (SQLite WAL — chats, history), `attachments/<chatId>/` (attachments). Old chats are cleaned up automatically after 24 h.

## SSH authentication

By default `root` / `wirenboard` (Wiren Board factory credentials). In «Settings»:

1. **Private key** — path to the file. Tried first.
2. **Password** — fallback (with keyboard-interactive).

## Custom AI Proxy

For corporate proxies with TLS-MITM that proxy OpenAI-compatible endpoints (Copilot, a corporate gateway, etc.):

1. Provider: **Custom AI Proxy**
2. Base URL: the real upstream API (e.g. `https://api.githubcopilot.com`)
3. API key: can be a dummy if the proxy injects the real one
4. Proxy for the LLM: `https://USER:PASS@host:port` (auth right in the URL)
5. Proxy CA certificate: upload a `.pem` file — its contents are stored in `settings.json` and go into `tls.ca` of Bun's fetch

The «refresh list» button works even if the proxy does not expose `/v1/models`: it hits `/v1/chat/completions` with a fake model and parses «Available models: …» from the 400 response.

> **OpenAI Chat Completions API only.** The Anthropic Messages API is not supported.

## Building and development

Dependencies: [Bun](https://bun.sh) 1.3+ (Node.js not required).

```bash
bun install

# Build
bun scripts/build.ts                    # binary for the current platform
bun scripts/build.ts --all              # linux-x64 + windows-x64
bun scripts/build.ts --target=linux-x64 # explicit target
bun scripts/build-appimage.ts           # AppImage (needs appimagetool + a built linux-x64)
bun scripts/smoke.ts                    # smoke test of the built binary

# Tests
bun test                                # all tests
bun test:unit                           # unit + lightweight integration (no binary)
bun test:api                            # API integration (needs a built binary)

# Type checking
bun run typecheck                       # tsc + vue-tsc

# Development (two terminals)
bun run dev:server                      # backend with hot-reload on :17321
bun run dev:web                         # vite dev on :5173 with proxy /api → :17321
```

Binaries land in `build/`. In dev mode open `http://127.0.0.1:5173/`.

## CI/CD

GitHub Actions builds the project automatically.

- **CI** (push to `main`, pull requests) — typecheck → build (linux-x64 + windows-x64) → upload artifacts (14 days)
- **Release** (push of a `v*` tag) — typecheck → build → AppImage → GitHub Release with binaries

### How to cut a release

Before tagging:
1. Bump `version` in `package.json`.
2. Move the entries from `## [Unreleased]` in `CHANGELOG.md` into a new `## [X.Y.Z] — YYYY-MM-DD` section and add the comparison link at the bottom.
3. Commit «chore: release X.Y.Z», merge into `main`.

```bash
git tag v0.13.0
git push origin v0.13.0
```

The tag must match `package.json:version`. In about a minute the release workflow builds and publishes.

In about a minute the binaries appear on the [Releases](../../releases) page.

## Architecture

```
src/
├── server/                  Bun + Hono, everything in one process
│   ├── index.ts             Bun.serve: HTTP + SSE + WebSocket (SSH terminal)
│   ├── settings.ts          per-provider profiles, CA cert inline (PEM in JSON)
│   ├── llm.ts               OpenAI streaming, agent loop (up to 20 turns)
│   ├── tools.ts             ~50 tools: mqtt/ssh/discovery/history/wb-rules
│   ├── history-chart.ts     chart rendering via vega-lite SSR (line/bar/heatmap/...)
│   ├── jobs.ts              tracker of background SSH jobs (in-memory)
│   ├── attachments.ts       files tagged source='user'|'assistant'
│   ├── chats.ts             SQLite store chats/turns + system prompt (language directive RU/EN)
│   ├── skills.ts            catalog + loading of skills (English, model-facing) into the LLM context
│   ├── ssh.ts               ssh2 client pool, exec/jobStart/openShell, SFTP
│   ├── mqtt-pool.ts         mqtt.js client pool
│   ├── discovery.ts         mDNS/avahi-browse scanner
│   ├── db.ts                bun:sqlite WAL + migrations
│   └── fixtures/skills/     17 markdown skills
└── web/                     Vue 3, Vite, no UI framework
    ├── App.vue              root layout
    ├── api.ts               API client + types
    ├── i18n.ts              UI dictionaries RU/EN + t()/plural()/fmtSize(), reactive lang
    ├── components/
    │   ├── ChatList.vue                Left sidebar (chats + delete-all undo)
    │   ├── ChatPane.vue                Chat + input field
    │   ├── ChatMessageList.vue         Message list + inline jobs
    │   ├── ChatMessage.vue             A single bubble (markdown + mermaid + hljs + files)
    │   ├── ChatInputArea.vue           Text + attachments + drag-drop
    │   ├── ControllerList.vue          Right sidebar + Web UI/Terminal icons
    │   ├── SettingsPanel.vue           Providers, keys, CA cert, prices, export/import
    │   ├── ComboboxSearch.vue          Typeahead model picker
    │   └── SshTerminal.vue             xterm.js bottom-sheet, WS to ssh2
    └── composables/useAttachments.ts
```

Under `bun build --compile` the frontend is packed into the binary via `import('./web/dist/...', { with: { type: 'file' } })` — no separate assets needed. The AppImage is a wrapper script (AppRun) over the same binary that finds Chrome/Chromium and launches it in `--app` mode.

### Localization (RU/EN)

Principle: **user-facing text is bilingual; model-facing text is single-language (English), because the model bridges languages itself**.

- **UI** — `src/web/i18n.ts`: a lightweight module without vue-i18n (`t()`/`plural()`/`fmtSize()`, reactive `lang`, autodetect from `localStorage('wb-lang')` + `navigator.language`). Components import `t`/`plural` directly. To add a string — put the key into both `ru`/`en` blocks and use `t('group.key')`.
- **`settings.uiLanguage`** (shared field, `WB_HELPER_LANGUAGE` env) sets the UI language and the few server strings the user sees: the system-prompt language directive (`LANG_DIRECTIVE` in `chats.ts` — a top-priority block prepended to the system prompt that forces the model to **reply strictly in the UI language**, overriding the Russian persona body), welcome/fallback/checkpoint messages and `getExtraSystemMsgs` (via the `L()` helper in `index.ts`).
- **Skills (`fixtures/skills/*.md`) and tool descriptions (`tools.ts`) are English-only, a single set.** These are model-facing instructions, never shown verbatim to the user; the model reads English and still replies in the UI language. No `.en.md` variants, no `toolSchemas(lang)`. The `{en, ru}` / `translations.ru` blocks inside `wb-rules.md` and `wb-serial-templates.md` are intentional — they document those skills' own bilingual APIs.
- The `[Система]` prefix is a technical protocol sentinel, not translated (the frontend strips it before display).

## Environment variables

Applied only on the first run and written into `settings.json`:

| Variable | Description | Default |
|----------|-------------|---------|
| `OPENAI_API_KEY` | initial LLM key | — |
| `OPENAI_BASE_URL` | custom endpoint | `https://api.openai.com/v1` |
| `OPENAI_MODEL` | model name | — |
| `WB_HELPER_PORT` | UI port | `17321` |
| `WB_HELPER_OPEN_BROWSER` | `0` to not open a window | `1` |
| `WB_HELPER_LANGUAGE` | UI/assistant language: `ru` or `en` | `ru` |
| `WB_HELPER_DISCOVERY_INTERVAL` | mDNS scan interval, ms | `15000` |
| `WB_HELPER_MQTT_USER` | MQTT login | — |
| `WB_HELPER_MQTT_PASSWORD` | MQTT password | — |
| `WB_HELPER_SSH_USER` | SSH login | `root` |
| `WB_HELPER_SSH_PASSWORD` | SSH password | `wirenboard` |
| `WB_HELPER_SSH_KEY` | path to a private key | — |
