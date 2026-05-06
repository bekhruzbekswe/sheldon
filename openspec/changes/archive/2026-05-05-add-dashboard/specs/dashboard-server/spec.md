## ADDED Requirements

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

### Requirement: GET /api/run-state

The endpoint SHALL respond JSON with `{phase, task, startedAt, deadlineAt, iterations, factsAdded, queuePending, queueDone, queueSkipped, queueInProgress}`. When no `run_state` row exists, it MUST return `{phase: 'idle', task: null, startedAt: null, deadlineAt: null, iterations: 0, factsAdded: 0, queuePending: 0, queueDone: 0, queueSkipped: 0, queueInProgress: 0}` (200 OK, not 404 — the dashboard treats this as the empty state).

#### Scenario: Active run

- **GIVEN** a `run_state` row with `phase='depth'`, `task='What is RAG?'`, and frontier rows in mixed states
- **WHEN** `GET /api/run-state` is called
- **THEN** the response is 200 with `phase: 'depth'`, `task: 'What is RAG?'`
- **AND** `factsAdded` equals `factStore.count()`
- **AND** the queue counts reflect the actual frontier table

#### Scenario: No run

- **GIVEN** no `run_state` row exists
- **WHEN** `GET /api/run-state` is called
- **THEN** the response is 200 with `phase: 'idle'` and the rest of the documented zero-defaults

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

### Requirement: Read-only endpoints

The dashboard server SHALL NOT expose any endpoint that mutates state — no POST, PATCH, PUT, or DELETE handlers. Any non-GET request MUST return 405.

#### Scenario: POST is refused

- **WHEN** `POST /api/run-state` is called with any body
- **THEN** the response status is 405
