## Why

`bun run watch` is enough for a developer reading the JSONL tail, but the user explicitly wanted a friendly UI for the multi-hour run experience: glance at it, see phase + countdown, see what the agent is currently working on, see facts streaming in, see the firehose with filters. A polished HTML dashboard from the Claude Design artifact (`Sheldon Dashboard v2.html`) was already designed and iterated on. L8 is the implementation: serve that design as a live UI backed by the existing SQLite + JSONL stores.

## What Changes

- New `bun run dashboard [--port 4000]` CLI starting a local Hono HTTP server.
- New `src/server.ts` exposing:
  - `GET /` — serves the modified dashboard HTML.
  - `GET /api/run-state` — current `run_state` row + derived counts.
  - `GET /api/frontier` — full frontier rows (no embeddings).
  - `GET /api/facts?limit=20` — most recent facts.
  - `GET /api/stats` — `{factsCollected, dedupeRate, scrapeSuccess, llmTokens}` plus 30-bucket sparkline arrays for each.
  - `GET /api/events` (SSE) — live event stream with `kind`, `layer`, `durationMs`, `ts`, `summary` (formatted), `error?`.
- New `src/format.ts` payload→summary formatter: turns each event kind's structured payload into the human string the design expects (e.g. `fact.write` → `"#287 71% of US workers worry…"`, `frontier.push` → `"q#19 'How is Article 22 enforced?' · 0.78"`).
- New `web/index.html` adapted from `Sheldon Dashboard v2.html`:
  - Removed all `setInterval`-driven mock data spawning (`spawnEvent`, `spawnFact`, `advancePipeline`).
  - Removed hardcoded `RUN`, `FRONTIER`, `FACT_POOL`, `SAMPLE_EVENTS`.
  - Wires `fetch('/api/run-state')`, `/api/frontier`, `/api/facts`, `/api/stats` on a polling cadence (2s for run/frontier, 5s for facts/stats).
  - Replaces `setInterval(spawnEvent, ...)` with a single `EventSource('/api/events')` that calls `pushEvent` on each message.
  - Keeps every layout rule, animation, color, and renderer untouched. The visual output matches the design.
- Empty-state path: when no `run_state` row exists, `/api/run-state` returns `{ phase: 'idle', task: null, ... }` and the body's `data-phase` is set to `idle`, which the design already handles.

Out of scope: write actions (no buttons that change agent behavior), authentication (localhost-only), historical multi-run views, mobile layout.

## Capabilities

### New Capabilities

- `dashboard-server`: Hono HTTP server at `http://localhost:<port>` serving the dashboard HTML, REST endpoints reading from `.sheldon/sheldon.db` and the events log, and an SSE endpoint that broadcasts new `events.jsonl` lines as they're appended.
- `dashboard-ui`: Single-page HTML dashboard at `web/index.html` rendering the design. Wires to `/api/*` endpoints; no mock data; no third-party dependencies; works while a `bun run research` is in flight.

### Modified Capabilities

(none — L8 is purely additive)

## Impact

- Code: new `src/server.ts`, `src/format.ts`, `src/dashboard.ts` (CLI), `web/index.html`. No changes to the agent loop. No schema changes.
- Dependencies: `hono` (small, well-supported on Bun).
- Storage: dashboard reads, never writes. Browser caches static HTML.
- CLI: `bun run dashboard` script wired in `package.json`. Starts the server in the foreground; user opens the printed URL in a browser.
- Network: bound to `127.0.0.1` by default (no external exposure).
