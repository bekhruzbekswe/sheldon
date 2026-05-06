# L8 — Live dashboard *(optional)*

## Goal

Optional polish: a small web dashboard at `http://localhost:4000` showing the agent's live state — current phase, time remaining, frontier (top N pending questions with scores), recent events, fact count by topic, scrape status. Updates in real time via SSE.

Whether we build this depends entirely on whether L1's JSONL tail is enough in practice. After running a real 5-hour agent and watching the tail, decide. If the tail feels like reading a wall of text and you want a dashboard, build this. If not, skip.

## Capabilities introduced

- `dashboard-server` — Hono HTTP server on port 4000 (configurable)
- `dashboard-events` — SSE endpoint that re-broadcasts JSONL events as they arrive (read-only follower of `.sheldon/events.jsonl`)
- `dashboard-ui` — a single static HTML page (no build step) that consumes the SSE feed and renders state

## Dependencies

- L1 / `event-log` (the SSE feed reads the JSONL file)
- L3 / `fact-store` (read-only queries for fact counts, topics)
- L4 / `frontier-queue` (read-only queries for pending questions)
- L5 / `phase-machine` (read-only access to current phase + deadline)

## Key data structures / decisions

**Process model:** the dashboard runs in the **same** process as the agent (Hono is cheap). Pros: no IPC. Cons: dashboard work could slow the agent — but Hono is so light this is hypothetical.

Alternative: run the dashboard in a separate process that opens the SQLite read-only and tails the JSONL. More resilient (dashboard crash doesn't kill the run) but more setup. Default to in-process for L8 v1; revisit if it causes problems.

**UI layout (sketch):**
```
+------------------------------------------------------------+
| Sheldon — "top pain points of AI age"                       |
| Phase: DEPTH  ·  T+2h 14m  ·  T-2h 46m to synthesis         |
+------------------------------------------------------------+
| Frontier (12 pending)            | Facts (247)              |
|  0.88  EU AI Act regulation      |  jobs        58          |
|  0.82  Energy cost of training   |  privacy     43          |
|  0.79  Deepfake detection rates  |  energy      31          |
|  0.74  ...                       |  regulation  29          |
|                                  |  ...                     |
+------------------------------------------------------------+
| Recent events (live)                                        |
| 14:23:01  scrape  pewresearch.org/...    412ms 8.1KB        |
| 14:23:18  fact    "71% of US workers..."  → #243            |
| 14:23:22  llm     fast (0.6s)                               |
| 14:23:24  search  "deepfake detection"  → 7 results         |
| ...                                                         |
+------------------------------------------------------------+
```

Vanilla HTML + a tiny bit of JS, no framework. SSE feeds events; client maintains client-side state from them.

**No write actions:** dashboard is read-only. No "kill question", "boost score", "add manual question" buttons. If you want to intervene, kill the process and edit the SQLite directly.

## Out of scope

- Authentication — `localhost` only, single-user.
- Mobile responsive — desktop only.
- History / past runs — current run only. Past runs live as `report.md` files.
- Multiple concurrent runs — Sheldon is single-run-at-a-time.

## Open questions

- Build at all? Punt the decision until after the first real L7 completes. If `bun run watch` is sufficient, declare victory.
- If we build it, do we ever want to expose it remotely (e.g. via Tailscale)? Not in scope, but the read-only design means it'd be safe to.
