# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
bun install                           # Install dependencies

# Development (run concurrently)
bun run dev:server                    # Backend with hot-reload on :17321
bun run dev:web                       # Frontend Vite dev server with proxy on :5173

# Build
bun scripts/build.ts                  # Build for current platform
bun scripts/build.ts --all            # Cross-compile: linux-x64 + windows-x64
bun scripts/build.ts --target=linux-x64

# Type checking (no separate linter)
bun run typecheck

# Smoke test (launches binary, verifies API + embedded frontend)
bun scripts/smoke.ts
```

## Architecture

WB AI Helper is a single-binary desktop AI assistant for Wiren Board IoT controllers. It bundles a Hono HTTP backend and a Vue 3 frontend into one standalone binary (Bun `--compile`).

**Stack:** Bun + Hono (backend), Vue 3 + Vite (frontend), SQLite (persistence), OpenAI SDK (LLM), MQTT + SSH + HTTP (device protocols), bonjour-service (mDNS discovery).

### Request lifecycle

1. Frontend POSTs to `POST /api/chats/:id/message`
2. Backend appends message to SQLite, opens SSE stream back to client
3. `llm.ts` calls LLM with full chat history + tool schemas; streams text deltas and tool calls
4. `tools.ts` dispatches each tool call to MQTT/SSH/HTTP pools; results injected back into LLM context
5. Loop continues (max 8 turns) until `finish_reason === 'stop'`
6. Final assistant turn persisted to SQLite; SSE stream closed

### Key source files

| File | Role |
|------|------|
| `src/server/index.ts` | Entry point — initialises all subsystems, registers Hono routes |
| `src/server/llm.ts` | OpenAI streaming client + agentic tool-call loop, yields `StreamEvent`; collects token usage |
| `src/server/tools.ts` | Tool schema definitions + dispatch; 9 tools for list/probe/mqtt/ssh |
| `src/server/mqtt-pool.ts` | Per-controller MQTT connection pool; read/write/list |
| `src/server/ssh.ts` | SSH pool with key → password fallback (default: root/wirenboard) |
| `src/server/discovery.ts` | mDNS scanner — parses `wirenboard-<SN>.local`, broadcasts via SSE every 15 s |
| `src/server/db.ts` | SQLite WAL, auto-migration on startup |
| `src/server/chats.ts` | Chat/turn CRUD; holds the system prompt (in Russian) |
| `src/server/settings.ts` | JSON config at `wb-ai-helper-settings.json`; env vars populate defaults on first run |
| `src/server/embed.ts` | Serves embedded frontend assets from binary (generated at build time) |
| `src/web/App.vue` | Root Vue component — three-panel layout, SSE consumer |
| `src/web/api.ts` | Fetch-based API client + SSE parser |

### Build pipeline

1. Vite bundles `src/web/` → `dist/`
2. `scripts/build.ts` generates `src/server/embed-manifest.ts` (static imports for every dist asset)
3. `bun build --compile` bundles `src/server/index.ts` with embedded assets into a single ELF/PE binary
4. Build uses a tmpfs scratch directory to work around ELF-rewriting constraints on some filesystems

### Runtime files (created next to binary)

- `wb-ai-helper-settings.json` (mode 600) — credentials and config
- `wb-ai-helper.db` — SQLite with `chats`, `turns`, `manual_controllers` tables

### Environment variables (seed settings on first run)

`OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL`, `WB_HELPER_PORT` (default 17321), `WB_HELPER_MQTT_USER`, `WB_HELPER_MQTT_PASSWORD`, `WB_HELPER_SSH_USER`, `WB_HELPER_SSH_PASSWORD`, `WB_HELPER_SSH_KEY`, `WB_HELPER_DISCOVERY_INTERVAL`, `WB_HELPER_OPEN_BROWSER`.

## TypeScript notes

- `tsconfig.json` targets ES2022 with `strict: true` and `noUncheckedIndexedAccess: true`
- `tsconfig.web.json` covers Vue templates; run `bun run typecheck` to check both
- Frontend and backend share no compiled output — Bun resolves everything at build time
