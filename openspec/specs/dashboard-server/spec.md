# dashboard-server Specification

## Purpose

Local Hono HTTP server that powers the L8 web dashboard. Read-only, bound to `127.0.0.1`. Serves the static dashboard HTML and exposes REST snapshots of run state, frontier queue, recent facts, and rolled-up stats — plus a Server-Sent Events stream that tails `.sheldon/events.jsonl` and broadcasts each new line as a formatted event. No mutation endpoints; non-GET requests are 405. Multiple browsers can connect simultaneously; each gets its own SSE tail.

## Requirements
### Requirement: HTTP server bound to localhost

The dashboard server SHALL listen on `127.0.0.1:<port>` (default `4000`, configurable via `--port`). It MUST NOT bind to `0.0.0.0` by default. It MUST log a single line to stderr on start with the URL.

#### Scenario: Default port is 4000

- **WHEN** `bun run dashboard` is started
- **THEN** the server listens on `http://127.0.0.1:4000`
- **AND** stderr contains a line that includes that URL

#### Scenario: Port override

- **WHEN** `bun run dashboard --port 5050` is started
- **THEN** the server listens on `http://127.0.0.1:5050`

### Requirement: GET / serves the dashboard HTML

The root path SHALL respond `200 text/html` with the contents of `web/index.html`. It MUST NOT require authentication.

#### Scenario: Root returns dashboard

- **WHEN** `GET /` is called
- **THEN** the response status is `200`
- **AND** the `Content-Type` starts with `text/html`
- **AND** the body is non-empty and contains the string `Sheldon`

### Requirement: GET /api/run-state returns the current run snapshot

The dashboard server SHALL provide a `GET /api/run-state` route returning a snapshot of the active run's high-level state. The response MUST include:

- `task: string` — the user's research task string.
- `phase: 'breadth' | 'depth' | 'synthesis' | 'done'` — current phase from `run_state.phase`.
- `startedAt: number` — Unix-ms start timestamp.
- `deadlineAt: number` — Unix-ms deadline (informational; not enforced by this endpoint).
- `endedAt: number | null` — Unix-ms end timestamp when phase has transitioned to `'done'`, else `null`.
- `iterations: number` — cumulative iteration count from frontier rows reaching a terminal status.
- `factsAdded: number` — count of rows in the `facts` table.
- queue counts: `pending`, `inProgress`, `done`, `skipped` from the `frontier` table.

The handler MUST invoke `resetDb()` before reading. When no run exists, the response is HTTP 200 with `null`.

#### Scenario: Active run returns full state

- **GIVEN** an active run in `'depth'` phase with 47 facts and a mix of frontier statuses
- **WHEN** `GET /api/run-state` is called
- **THEN** the response is HTTP 200 with `phase: "depth"`, `factsAdded: 47`, and the queue counts reflecting the frontier table
- **AND** `endedAt: null` (phase is not yet `'done'`)

#### Scenario: Finished run has endedAt populated

- **GIVEN** a run that has reached `phase: 'done'`
- **WHEN** `GET /api/run-state` is called
- **THEN** the response includes a non-null `endedAt` Unix-ms timestamp

#### Scenario: No run returns null

- **GIVEN** the `run_state` table is empty
- **WHEN** `GET /api/run-state` is called
- **THEN** the response is HTTP 200 with body `null`

### Requirement: GET /api/frontier

The endpoint SHALL respond JSON: an array of `{id, q, score, status, depth, parent, factsAdded}` covering every frontier row, ordered by `id ASC`. Embedding columns MUST NOT be included. `factsAdded` for done/skipped rows is the count of `facts` rows whose `question_id` equals the frontier id.

#### Scenario: Frontier mirrors database

- **GIVEN** the frontier has 3 rows
- **WHEN** `GET /api/frontier` is called
- **THEN** the response is 200 with a 3-element array
- **AND** no element contains an `embedding` field

### Requirement: GET /api/facts?limit=N

The endpoint SHALL respond JSON: an array of `{id, claim, url, site, title, topic, conf, ts}` ordered by `created_at DESC`, default `limit=20`, max `limit=100`. `site` is the URL's hostname. `topic` is the row's `topic_tag` (may be empty string). `conf` is `confidence` defaulted to `0` if NULL.

#### Scenario: Default limit returns 20

- **GIVEN** 50 facts in the store
- **WHEN** `GET /api/facts` is called
- **THEN** the response is a 20-element array
- **AND** the first element has the largest `id` (most recent)

### Requirement: GET /api/stats

The endpoint SHALL respond JSON `{factsCollected, dedupeRate, scrapeSuccess, llmTokens, sparks}` where `sparks` is `{facts, dedupe, scrape, tokens}` and each is a 30-element numeric array (one bucket per minute over the last 30 minutes; missing buckets are `0` for facts/tokens, the prior value for rates).

- `factsCollected` = `factStore.count()`.
- `dedupeRate` = `fact.dedupe / (fact.write + fact.dedupe)` over the entire log, expressed as 0..1.
- `scrapeSuccess` = `scrape.fetch / (scrape.fetch + scrape.skip)` over the entire log.
- `llmTokens` = sum of `payload.completion_tokens + payload.prompt_tokens` across `llm.fast` and `llm.deep` events.

#### Scenario: Stats are derived counts

- **WHEN** `GET /api/stats` is called against a log with 100 `fact.write` and 25 `fact.dedupe` events
- **THEN** the response's `dedupeRate` is `0.2` (25 / 125)

### Requirement: GET /api/events SSE stream

The endpoint SHALL respond `text/event-stream` and stream every newly appended `.sheldon/events.jsonl` line as one SSE message. Each message's `data` field is JSON `{ts, kind, layer, durationMs?, summary, error?}`. The connection MUST stay open until the client disconnects. The summary string MUST be derived by the payload formatter (see `format.ts`).

#### Scenario: Live append streams to clients

- **GIVEN** an SSE connection is open
- **WHEN** a new line is appended to `.sheldon/events.jsonl`
- **THEN** the client receives an SSE `data:` line within 500ms
- **AND** the JSON includes a non-empty `summary`

#### Scenario: SSE survives empty log

- **GIVEN** `.sheldon/events.jsonl` does not exist
- **WHEN** the client connects to `/api/events`
- **THEN** the connection succeeds (200) and remains open
- **AND** when the file is later created and a line written, that line is streamed

### Requirement: GET /api/contract returns the current research contract

The dashboard server SHALL provide a `GET /api/contract` route returning the parsed contract from `run_state.contract_json`, or `null` when no run is active or the row's `contract_json` is null/unparseable.

Response shape (success):

```json
{
  "core_question": "string",
  "sub_questions": ["string", "..."],
  "good_answer_contains": ["string", "..."],
  "out_of_scope": ["string", "..."]
}
```

Response shape (no contract): `null` with HTTP 200.

The handler MUST invoke `resetDb()` before reading (matches the existing pattern for non-SSE `/api/*` handlers to survive `SQLITE_IOERR_VNODE` after `--fresh`). Parse failures from malformed JSON in the column return `null` with HTTP 200, not 500 — the dashboard treats "no contract yet" identically to "contract column unparseable".

#### Scenario: Active run with valid contract returns parsed object

- **GIVEN** a `run_state` row whose `contract_json` is a valid JSON object with all four fields
- **WHEN** `GET /api/contract` is called
- **THEN** the response is HTTP 200 with the parsed object
- **AND** `sub_questions`, `good_answer_contains`, `out_of_scope` are arrays of strings

#### Scenario: No active run returns null

- **GIVEN** the `run_state` table is empty (no run started, or `clearAll` just ran)
- **WHEN** `GET /api/contract` is called
- **THEN** the response is HTTP 200 with body `null`

#### Scenario: Unparseable contract_json returns null gracefully

- **GIVEN** a `run_state` row whose `contract_json` is `"not-json"`
- **WHEN** `GET /api/contract` is called
- **THEN** the response is HTTP 200 with body `null`
- **AND** the server does not return HTTP 500

### Requirement: GET /api/report returns the latest report rendered to HTML with clickable citations

The dashboard server SHALL provide a `GET /api/report` route that returns the most recent rendered report. Resolution order:

1. If `run_state.contract_json` exists AND a report file exists at `.sheldon/reports/<run_state.started_at>.md`, use that file.
2. Otherwise, fall back to `.sheldon/reports/latest.md` if it exists.
3. Otherwise return HTTP 200 with body `null`.

Response shape (success):

```json
{
  "path": "string (the report file path)",
  "html": "string (rendered HTML with citation links)",
  "sources": [{ "n": number, "title": "string", "url": "string" }]
}
```

The renderer MUST:

- Parse the Markdown into HTML (a small built-in converter; no new dependency required). At minimum: H1 / H2 / H3 headings, paragraphs separated by blank lines, bold (`**…**`), italic (`*…*` / `_…_`), inline code (`` `…` ``), bulleted lists (`- ` / `* `), numbered lists (`1. `).
- Parse the `## Sources` section into the `sources` array. Each source line has shape `[N] Title — URL` or `[N] URL`. Extract `{n, title, url}` per entry.
- Rewrite every `[N]` citation token in the body HTML to `<a href="<url>" target="_blank" rel="noopener" class="citation">[N]</a>` using the URL map from the sources section. Unknown numbers (no matching source) are left as plain text `[N]` without a link.
- The `## Sources` section itself is rendered as part of the HTML (so the user sees the bibliography in-line), with each entry's URL as a link.

The handler MUST invoke `resetDb()` before reading (consistent with other `/api/*` non-SSE handlers). Missing or unreadable report files return `null` with HTTP 200 (not 500).

#### Scenario: Latest report rendered with citation links

- **GIVEN** a finished run whose report at `.sheldon/reports/1778517833145.md` contains the body text `"…outsourcing firms face a structural crisis [1][2]."` and a Sources section with `[1] A — https://a.example` and `[2] B — https://b.example`
- **WHEN** `GET /api/report` is called
- **THEN** the response is HTTP 200 with `path: ".sheldon/reports/1778517833145.md"`
- **AND** `html` contains the substring `<a href="https://a.example" target="_blank" rel="noopener" class="citation">[1]</a><a href="https://b.example" target="_blank" rel="noopener" class="citation">[2]</a>`
- **AND** `sources` has length 2 with `n`, `title`, and `url` fields populated

#### Scenario: Unknown citation number is preserved as plain text

- **GIVEN** a report whose body contains `[99]` but whose Sources section has no entry for `99`
- **WHEN** the report is rendered
- **THEN** the rendered `html` contains the literal text `[99]` (no `<a>` wrapper)

#### Scenario: No report exists returns null

- **GIVEN** the `.sheldon/reports/` directory has no `.md` files
- **WHEN** `GET /api/report` is called
- **THEN** the response is HTTP 200 with body `null`

### Requirement: GET /api/synthesis-state returns a snapshot of v2 synthesis pipeline state

The dashboard server SHALL provide a `GET /api/synthesis-state` route that derives a structured snapshot from the most-recent terminal events in `events.jsonl`. The endpoint is called once per dashboard page load; subsequent updates flow through the existing SSE event channel.

Response shape:

```json
{
  "substep": "idle" | "thesis-drafting" | "triangulating" | "writing" | "editing" | "stitching" | "done" | "fallback",
  "thesisClaimCount": number | null,
  "claims": [
    {
      "headline": "string",
      "corroborations": number,
      "contradictions": number,
      "contested": boolean
    }
  ] | null,
  "sectionsWritten": number,
  "sectionsDropped": number,
  "reportPath": "string" | null,
  "fallbackReason": "string" | null
}
```

Substep derivation rules (the implementation walks `events.jsonl` backwards from end-of-file; first match wins for each field):

- `synthesis.fallback` present anywhere in the synthesis sub-trace → `substep: "fallback"`, `fallbackReason: <reason>`.
- `report.written` present → `substep: "done"`, `reportPath: <path>`.
- `section.written` count ≥ `thesis.drafted.claimCount` (most-recent draft) AND no `report.written` yet → `substep: "stitching"`.
- `section.rubric` for a section that already has `section.written` (i.e., revision evaluation) → `substep: "editing"`.
- At least one `section.written` after the most-recent `thesis.drafted`, not yet stitching/editing → `substep: "writing"`.
- At least one `claim.triangulated`, no later `section.written` → `substep: "triangulating"`.
- `thesis.drafted` present, no later `claim.triangulated` or section events → `substep: "thesis-drafting"`.
- Otherwise → `substep: "idle"`.

`thesisClaimCount` reads from the most-recent `thesis.drafted` event's `payload.claimCount`. `claims` array reads `payload.{claimHeadline, corroborations, contradictions, contested}` from `claim.triangulated` events for the most-recent thesis. `sectionsWritten` counts `section.written` events emitted after the most-recent `thesis.drafted` (or globally for the cluster-fallback path). `sectionsDropped` counts `section.dropped` events similarly.

The handler MUST invoke `resetDb()` before reading (consistent with other `/api/*` handlers). Empty / malformed events file returns `{substep: "idle", ...all-null-or-zero-fields}` with HTTP 200.

#### Scenario: Active run mid-triangulation returns triangulating substep

- **GIVEN** the events file contains a recent `thesis.drafted` event with `claimCount: 6` followed by 2 `claim.triangulated` events and 0 `section.written` events
- **WHEN** `GET /api/synthesis-state` is called
- **THEN** the response has `substep: "triangulating"`
- **AND** `thesisClaimCount: 6`
- **AND** `claims` has length 2 with each entry's `headline` / `corroborations` / `contradictions` / `contested` fields populated from the events
- **AND** `sectionsWritten: 0`, `sectionsDropped: 0`, `reportPath: null`

#### Scenario: Cluster fallback returns fallback substep

- **GIVEN** the events file contains a `synthesis.fallback` event with `payload.reason: "sparse_corpus"`
- **WHEN** `GET /api/synthesis-state` is called
- **THEN** the response has `substep: "fallback"`
- **AND** `fallbackReason: "sparse_corpus"`

#### Scenario: Finished run returns done substep with report path

- **GIVEN** the events file contains `thesis.drafted`, sections, and a terminal `report.written` event with `payload.path: ".sheldon/reports/X.md"`
- **WHEN** `GET /api/synthesis-state` is called
- **THEN** the response has `substep: "done"`
- **AND** `reportPath: ".sheldon/reports/X.md"`

#### Scenario: Empty events file returns idle

- **GIVEN** `.sheldon/events.jsonl` does not exist OR contains zero relevant synthesis events
- **WHEN** `GET /api/synthesis-state` is called
- **THEN** the response is HTTP 200 with `substep: "idle"` and all detail fields null/zero

### Requirement: Read-only endpoints

The dashboard server SHALL NOT expose any endpoint that mutates state — no POST, PATCH, PUT, or DELETE handlers. Any non-GET request MUST return 405.

#### Scenario: POST is refused

- **WHEN** `POST /api/run-state` is called with any body
- **THEN** the response status is 405

