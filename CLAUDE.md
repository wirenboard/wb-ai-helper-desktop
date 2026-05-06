# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
bun install                              # Install dependencies

# Development (run concurrently)
bun run dev:server                       # Backend with hot-reload on :17321
bun run dev:web                          # Frontend Vite dev server with proxy on :5173

# Build
bun scripts/build.ts                     # Compile for current platform
bun scripts/build.ts --all               # Cross-compile linux-x64 + windows-x64
bun scripts/build.ts --target=linux-x64  # Explicit target
bun scripts/build-appimage.ts            # Wrap linux-x64 binary into an AppImage
bun scripts/smoke.ts                     # Spawn binary, hit API, verify embedded UI

# Type checking (no separate linter)
bun run typecheck
```

## Architecture

WB AI Helper is a single-binary desktop AI assistant for Wiren Board IoT controllers. It bundles a Hono HTTP backend and a Vue 3 frontend into one standalone binary (Bun `--compile`); the AppImage wraps that binary plus a launcher script that opens a Chromium app-mode window.

**Stack:** Bun + Hono (backend), Vue 3 + Vite (frontend), SQLite WAL (persistence), OpenAI SDK + custom fetch (LLM), MQTT.js + ssh2 (device protocols), bonjour-service / avahi-browse (mDNS), vega-lite SSR (charts), xterm.js (in-app SSH terminal).

### Request lifecycle (chat)

1. Frontend POSTs to `POST /api/chats/:id/message`
2. Backend appends user message to SQLite, opens an SSE stream
3. `llm.ts` calls LLM with full chat history + tool schemas; emits `text-delta`, `tool-call`, `tool-result`, `usage`, `done` events
4. `tools.ts` dispatches each tool call (~50 tools) to MQTT/SSH/HTTP pools / discovery / chart renderer / job tracker
5. Loop continues until `finish_reason === 'stop'` OR `maxTurns` (20) is reached. On `max_turns` without text the backend appends a fallback message asking the user to say "продолжай"
6. Final assistant turn persisted with `tokensPrompt/Completion/Cached/totalCost` + `created_at`

### LLM provider profiles

`settings.providers: Record<provider, ProviderConfig>` — switching `settings.provider` swaps every LLM-side field at once (apiKey, baseURL, model, prices, llmProxy, tlsInsecure, caCert, apiFormat). Three profiles:

| profile        | baseURL editable | apiFormat editable | caCert | typical use |
|----------------|------------------|--------------------|--------|-------------|
| `openai`       | no (api.openai.com fixed) | no | no  | direct OpenAI |
| `custom`       | yes              | yes                | no  | any OpenAI-compatible (Ollama, LiteLLM, vLLM…) |
| `custom_proxy` | yes              | yes                | yes | MITM proxy (Claude proxy) — auth in URL, CA-cert PEM stored inline in settings.json |

`apiFormat` is `'openai'` for now; the type allows for future Anthropic/Responses-API support but no other backend exists today.

`buildLlmClient(s)` in `index.ts` picks `cur = s.providers[s.provider]` and builds OpenAI client with a custom fetch that handles `proxy`, `tls.rejectUnauthorized`, `tls.ca`. Settings whitelisted on PUT; per-provider fields are routed into `providers[targetProvider]` automatically by `mergeWithMigration`.

### Key source files

| File | Role |
|------|------|
| `src/server/index.ts` | Entry point — Bun.serve with WebSocket upgrade for SSH, all Hono routes |
| `src/server/llm.ts` | Streaming agent loop; up to 20 turns; usage with optional `total_cost` |
| `src/server/tools.ts` | ~50 tool schemas + dispatch; includes `wb_bus_scan`, `serial_debug_collect`, `audit_controller`, `save_state_for_diff`, `get_history`/`get_history_chart`/`get_history_table`, `save_rule`/`load_rule`/`delete_rule`, attachment ops, jobs |
| `src/server/history-chart.ts` | vega-lite SSR — line/bar/area/point/histogram/heatmap/boxplot, twin Y-axes for two-unit groups, normalised axis for 3+ unit groups |
| `src/server/jobs.ts` | In-memory `Map<jobId, TrackedJob>` — sn / label / state / sessionId. NOT persisted across restarts |
| `src/server/ssh.ts` | ssh2 pool: `exec`, `jobStart` (systemd-run transient unit), `jobStatus/jobTail/jobCancel`, `openShell` (PTY for in-app terminal), SFTP read/write/download |
| `src/server/discovery.ts` | mDNS via bonjour + `avahi-browse -a -r -p` fallback. `notify(force=true)` always emits on the periodic tick so UI sees liveness |
| `src/server/attachments.ts` | Filename format `${id}_${u\|a}__${name}` — `source` flag distinguishes user uploads from assistant-produced files. List filters by source |
| `src/server/settings.ts` | Per-provider config + migration from legacy flat schema; `listModels` with retry + `probeModelsViaError` fallback for proxies that don't expose `/v1/models` |
| `src/server/chats.ts` | SQLite chats/turns; system prompt (RU); turn aggregation queries include `total_cost` |
| `src/server/skills.ts` | 17 markdown skills (`fixtures/skills/*.md`) loaded into context via `load_skill` |
| `src/server/db.ts` | bun:sqlite WAL with idempotent ALTER TABLE migrations |
| `src/web/App.vue` | Root layout, theme/font, chat lifecycle, jobs polling, file upload-strip clearing on send |
| `src/web/components/SshTerminal.vue` | xterm.js bottom sheet, WebSocket to `/api/ssh/:sn/shell` |
| `src/web/components/SettingsPanel.vue` | Provider radio, conditional fields per profile, CA-cert upload, export/import |

### SSE & WebSocket endpoints

| URL                       | Type | Purpose |
|---------------------------|------|---------|
| `GET /api/events`         | SSE (`text/event-stream`) | Controller list updates; `notify(force=true)` ensures periodic emission |
| `POST /api/chats/:id/message` | SSE | Per-request chat stream — `text-delta`, `tool-call`, `tool-result`, `usage`, `done` |
| `GET /api/ssh/:sn/shell`  | WebSocket | xterm bridge — JSON frames `{t:'init/data/resize'}` ↔ `{t:'data/ready/error/close'}` |

`Bun.serve` runs with `idleTimeout: 0` because tool-call gaps in chat SSE often exceed Bun's default 10 s. The WebSocket upgrade is gated by URL pattern in `fetch()` before delegating to Hono.

`tool-result` events carry `ok: boolean`; tool errors are persisted in DB with a `\x01` prefix so the UI shows red vs green dots.

### Background jobs

Tools `ssh_exec_async`, `wb_bus_scan`, `serial_debug_collect` spawn a `systemd-run --unit=wb-ai-job-<8hex>` transient unit on the controller. Files at `/mnt/data/ai/wb-ai-helper/jobs/<jobId>.{sh,log,label,started}`. Frontend polls `/api/chats/:id/jobs` every 3 s — jobs are surfaced inline next to their originating tool group. Cancellation has a 5 s undo window (`scheduleCancelJob` → real `api.cancelJob` after delay; `undoCancelJob` clears the timer).

### Build pipeline

1. `bun run build:web` (Vite) → `src/web/dist/`
2. `scripts/build.ts` regenerates `src/server/embed-manifest.ts` (static `import('./web/dist/...', { with: { type: 'file' } })` for every dist asset), runs `bun build --compile`, then resets the manifest to an empty stub so hashed filenames don't pollute git
3. `scripts/build-appimage.ts` copies the linux-x64 binary into a `.AppDir`, writes an `AppRun` shell script that picks a free port, exports `WB_HELPER_PORT` and `NO_PROXY=127.0.0.1`, waits up to 20 s for `/api/health`, then opens Chromium with `--app=http://127.0.0.1:$PORT/`. If a server is already running on the default port, AppRun reuses it instead of starting a new one
4. The build itself runs in `/tmp/wb-ai-helper-build` (tmpfs) to work around ELF-rewriting constraints; retries up to 30× on transient failures

### Runtime files

| Mode | Path |
|------|------|
| AppImage | `~/.config/wb-ai-helper/` (XDG) — `APPIMAGE` env var triggers this branch |
| Compiled standalone | next to the binary |
| `bun --hot src/server/index.ts` (dev) | `~/.config/wb-ai-helper/` |

Per chat: `attachments/<chatId>/<id>_<u\|a>__<name>` — `clearAttachmentSession()` runs on chat delete so both user uploads and assistant-produced files are removed together. TTL is 24 h with hourly cleanup of stale chats.

### Settings precedence

`DEFAULTS` < env vars (first run only, written to disk) < `settings.json` (user via UI). Secrets — `apiKey`, `mqttPassword`, `sshPassword`, `llmProxyPassword` — never leave the backend; `toPublic()` replaces them with `*Configured` booleans. CA-cert PEM goes through, since the UI needs to show "✓ загружен (N КБ)".

### Environment variables (seed on first run)

`OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL`, `WB_HELPER_PORT` (default 17321), `WB_HELPER_OPEN_BROWSER` (`0` to skip), `WB_HELPER_DISCOVERY_INTERVAL`, `WB_HELPER_MQTT_USER`, `WB_HELPER_MQTT_PASSWORD`, `WB_HELPER_SSH_USER`, `WB_HELPER_SSH_PASSWORD`, `WB_HELPER_SSH_KEY`.

## CI/CD

GitHub Actions автоматически собирает проект при каждом пуше и релизе.

### CI (`.github/workflows/ci.yml`)

Запускается на push в `main` и на pull request. Шаги: typecheck → build (linux-x64 + windows-x64) → upload artifacts (14 дней).

### Release (`.github/workflows/release.yml`)

Запускается при пуше тега `v*`. Собирает бинарники и создаёт GitHub Release с файлами:
- `wb-ai-helper-linux-x64`
- `wb-ai-helper-windows-x64.exe`
- `README.txt`

### Как сделать релиз

1. Убедиться что CI на `main` зелёный
2. Обновить `version` в `package.json` если нужно
3. Создать и запушить тег:
   ```bash
   git tag v0.12.0
   git push origin v0.12.0
   ```
4. Release workflow соберёт бинарники и опубликует на https://github.com/wirenboard/wb-ai-helper-desktop/releases

## TypeScript notes

- `tsconfig.json` targets ES2022 with `strict: true` and `noUncheckedIndexedAccess: true`
- `tsconfig.web.json` covers Vue templates; run `bun run typecheck` to check both
- Frontend and backend share no compiled output — Bun resolves everything at build time. Shared types (e.g. `ChatTurn`, `LlmProvider`) are duplicated by convention, not imported across the boundary.

## Known holes / future work

- **Anthropic / Responses API:** structurally `apiFormat` is wired through but the only implemented branch is OpenAI Chat Completions. For Claude via the proxy, hit `api.anthropic.com` through Custom AI Proxy with `apiFormat='openai'` only works if the proxy speaks both formats; otherwise translation logic in `llm.ts` is needed.
- **i18n:** UI is RU-only (with one Vue i18n module half-written in a stash).
- **Job persistence:** `jobs.ts` is in-memory; restart loses tracking even though jobs continue running on controllers.
