# L1 — Visibility primitive (event log)

## Goal

Build the visibility floor *before* any agentic logic. Every action the agent takes — and every action layers above L1 take — writes a single line to a JSONL log file. A second-terminal `bun run watch` command tails that file with color-coded actions and timing, so the user can verify the agent is doing sensible things in real time, without trusting it.

This is intentionally the second layer (right after the LLM client), not bolted on later. Without visibility, every later layer is a black box.

## Capabilities introduced

- `event-log` — append-only JSONL event log with structured fields (timestamp, kind, payload, durationMs, layer-of-origin)
- `event-tail` — CLI command that follows the log, formats events into single colored lines, and supports filtering (e.g. `--kind search,scrape`)

## Dependencies

- L0 / `llm-client` — the LLM client should emit events for each call (kind `llm.fast` / `llm.deep`), so L1 must define the event format before we wire L0 to it. Practically: ship L1 first, then go back and instrument the LLM client.

## Key data structures / decisions

**Event shape (draft):**
```ts
type Event = {
  ts: string;          // ISO-8601 with ms precision
  kind: string;        // namespaced: "llm.fast", "search.query", "scrape.fetch", "fact.write"
  layer: string;       // "L0", "L2", "L3"…
  durationMs?: number; // for actions with measurable elapsed
  payload: unknown;    // free-form, kind-specific
}
```

**File location:** `.sheldon/events.jsonl` at the repo root (or whatever working directory the agent was launched from). Auto-created.

**Writer concurrency:** single process, append-only. No locking needed for L1; if L8 introduces a separate dashboard process reading the file, that's read-only so still fine.

**Tail UI:** terminal-only, ANSI colors. One line per event:
```
[10:14:08] LLM.FAST       (0.7s, 4 tok)   "What is 17*23?" → "391"
[10:14:09] SEARCH.QUERY   (0.3s)          "AI job displacement studies" → 8 results
```
Long payloads are truncated; full content is always in the JSONL.

**Filter syntax:** `bun run watch --kind llm.*` (glob), `--since 5m`, `--layer L3`.

**Log rotation:** none in L1. If the file grows large, that's a problem for L7/L8. For a 5-hour run we estimate ~10k events, ~2 MB — fine.

## Out of scope

- Web dashboard (that's L8 if needed)
- Querying the log programmatically (the SQLite stores will hold structured state; the log is for humans)
- Log shipping, tracing, OpenTelemetry — overkill for a single-process agent
- Encrypting payloads — local-only, plaintext is fine

## Open questions

- Should the event log be the canonical record of *what facts were stored*, or is the SQLite fact store the canonical record and the log is just narration? **Tentative answer:** SQLite is canonical; the log narrates. If the log is corrupted/deleted mid-run, the agent can keep going.
- Do we want a `kind` taxonomy enforced via TypeScript union types? Probably yes — easy refactor later, prevents typos at write sites.
