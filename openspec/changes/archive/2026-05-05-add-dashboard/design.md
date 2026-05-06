## Context

The user designed a polished dark-mode dashboard via Claude Design (`Sheldon Dashboard v2.html`, ~1700 lines, single file, vanilla JS, mock data driven by `setInterval`). It's been iterated extensively — final state has run-box (topic + clock), q-box (currently-asking + 4-step staircase pipeline), stats row (4 sparklines), lower row (frontier 38.2% + facts 61.8%), event log with kind-family filter chips and hover-pause, and a synthesis-state takeover.

L8 is the implementation layer: serve that design as a live UI backed by the existing SQLite (`facts`, `frontier`, `run_state`) and the events JSONL. The dashboard reads only — no buttons that mutate agent state.

## Goals / Non-Goals

**Goals**

- Local Hono HTTP server on `127.0.0.1:4000` with REST + SSE endpoints
- One vanilla-JS HTML page that fetches snapshots and subscribes to SSE
- Visual output identical to the design (only the data layer changes)
- Single command: `bun run dashboard`
- Empty state, active run, and synthesis takeover all driven by real data
- Robust SSE: tail-the-file with rotation safety; reconnect on the client side

**Non-goals**

- Authentication (localhost-only)
- Mobile / responsive (1280–1920 desktop only, per the design)
- Mutation endpoints
- Historical multi-run views (one active run at a time)
- React / framework migration of the design
- Deployment / Docker / proxying behind a reverse proxy

## Decisions

### Decision 1: Hono on Bun, not raw `Bun.serve`

**Why**: Hono is ~30 KB, Bun-friendly, has clean SSE support via `streamSSE`, and gives me REST routing for free. Raw `Bun.serve` is a few extra lines per route and SSE is more error-prone to hand-roll. The added dependency is small and well-maintained.

**Alternatives considered**:
- `Bun.serve` directly — viable but would mean writing my own router and SSE loop. Saves one dependency, costs maintainability.
- Express — too heavy, Node-flavored, would drag in transitive deps.
- A static file server with the dashboard polling JSON files on disk — simpler architecture but no SSE; the live event feel would be lost.

### Decision 2: Polling + SSE, not all-SSE

**Why**: Snapshot data (run state, frontier list, facts list, computed stats) is naturally request/response. SSE is right only for the firehose. Mixing the two:

- REST polling at 2s/5s for snapshots — robust, easy to debug, stateless.
- SSE for the event stream — bytes flow as the agent emits, no round-trip delay.

All-SSE would require a custom protocol over the SSE channel (subscription topics, replay-on-connect). Not worth it for a single-user local tool.

### Decision 3: Read SQLite in the same process via existing `getDb()`

**Why**: `bun:sqlite` works fine for concurrent read-only access against a database that another process is writing to (with `journal_mode=WAL`, which we already set). The dashboard server is a separate Bun process from `bun run research`, but they both `getDb()` the same file — SQLite handles the locking. No need for a separate query layer.

**Verification needed at runtime**: confirm that opening the DB in WAL mode in the dashboard process doesn't block the writer. We've run with WAL since L3, so this should be fine.

### Decision 4: Tail `events.jsonl` via polling, not `fs.watch`

**Why**: The same reason `bun run watch` does it — `fs.watch` on macOS for append-only files is unreliable. A 250ms polling loop on `Bun.file().stat()` is robust and the latency is imperceptible for human consumption. Mirrors L1's approach.

The server holds the last byte offset per SSE connection. On each tick: stat the file, read newly appended bytes, parse each line, call `formatEvent` to build the `summary`, push as SSE `data:` line.

### Decision 5: Payload-to-summary formatter is server-side, not client-side

**Why**: The design expects a `summary` string per event (e.g. `'q="GDPR Article 22 enforcement" · 12 hits'`). The structured payload our agent emits has fields like `query`, `resultCount`, `topUrl`. Converting once, server-side, means:

- The client doesn't carry per-kind formatting logic (already complex enough rendering).
- The wire format is small (one summary string instead of a structured payload).
- The formatter is one file (`src/format.ts`), one switch statement, easy to evolve.

If a future client wanted to render structured payloads differently (e.g. clickable URLs in scrape events), we'd add a structured field alongside `summary`. For now, summary-only.

### Decision 6: `web/index.html` is a *fork* of the design, not a runtime mutation

**Why**: The design file is a Claude Design artifact — kept as-is in `/tmp/sheldon-design/` for reference, but it's mock-data driven and not safe to serve. We copy + edit. Specifically: the `RUN`, `FRONTIER`, `FACTS`, `FACT_POOL`, `SAMPLE_EVENTS`, `ERR_EVENTS` declarations are removed; the `setInterval(spawnEvent...)`, `setInterval(spawnFact...)`, `setInterval(advancePipeline...)` calls are removed; `tickClock`, `setPhase`, `renderFrontier`, `renderFacts`, `renderLog`, `renderSparks` stay as-is; new `connectLive()` and `pollSnapshots()` functions handle data.

If the design ever updates, we re-fork (one re-apply of the data-layer patches).

### Decision 7: Localhost-only by default

**Why**: It's a single-user tool reading the user's research database. Binding `0.0.0.0` would expose the dashboard (including possibly sensitive research content) to anyone on the LAN. Default `127.0.0.1`. If someone wants remote access, they Tailscale or SSH-tunnel — explicit.

### Decision 8: `dashboard.ts` CLI runs in foreground

**Why**: Easier to Ctrl-C, no daemonization complexity. The user opens a second terminal: one for `bun run research`, one for `bun run dashboard`. Just like `bun run watch` already.

## Risks / Trade-offs

- **[Risk] SQLite reader lock contention with the writer.** → WAL mode avoids it. Documented; verify in smoke test.
- **[Risk] `events.jsonl` rotation/truncation breaks the offset tracking.** → For a single 5-hour run we don't rotate, so risk is theoretical. If we add rotation later, the SSE handler will need to detect file size shrinking and reset its offset.
- **[Risk] Many SSE clients × many events = redundant I/O.** → Each client's tail loop reads the file independently. For ~1 user × ~1 client this is fine. If we ever serve to many, we'd add a single tail process broadcasting to all subscribers via an in-memory queue.
- **[Risk] Polling at 2s creates jitter for the design's smooth animations.** → The design's animations are CSS-driven; data updates are independent of animation frames. Should be fine; verify in smoke test.
- **[Trade-off] The design fork drifts from the source.** → Acceptable for now. If the user designs v3, we re-fork. The data-layer patch is small and well-isolated.

## Migration Plan

Additive. No existing functionality changes. `bun run watch` (the terminal tail) keeps working. `bun run dashboard` is a new entrypoint.

## Open Questions

- Should the dashboard pause on tab-blur to save event traffic? **Decided**: no for now. EventSource on a hidden tab is cheap.
- Should the synthesis-takeover state be triggered by phase=synthesis OR by report.written? **Decided**: phase=synthesis. The takeover is a process indicator, not a result-ready indicator.
- Should we add a tiny status bar at the bottom showing connection state? **Decided**: deferred. The design is clean; only add if needed during real-use feedback.
