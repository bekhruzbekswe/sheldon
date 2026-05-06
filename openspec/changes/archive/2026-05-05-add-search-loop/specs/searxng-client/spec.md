## ADDED Requirements

### Requirement: Query a SearXNG instance and return ranked results

The `searxngClient.query(text, opts?)` function SHALL send an HTTP GET to `${SEARXNG_BASE_URL}/search?q=...&format=json&categories=general` and return an array of `{title, url, snippet}` ordered as the server returned them. The base URL is read from `SEARXNG_BASE_URL` (defaults to `http://localhost:8888`).

#### Scenario: Successful query returns ranked results

- **GIVEN** SearXNG is reachable at `http://localhost:8888`
- **WHEN** `searxngClient.query('AI job displacement studies')` is called
- **THEN** the returned array has at least one entry
- **AND** each entry has `title` (string), `url` (string), and `snippet` (string) fields

#### Scenario: Empty query rejected

- **WHEN** `searxngClient.query('')` is called
- **THEN** the function throws an Error mentioning "empty query"

### Requirement: Apply a hard request timeout

Each query SHALL time out after 10 seconds. On timeout the call MUST throw an Error mentioning `timeout`.

#### Scenario: Slow SearXNG times out

- **GIVEN** the SearXNG instance does not respond within 10s
- **WHEN** `searxngClient.query('anything')` is called
- **THEN** the call throws within ~10s
- **AND** the error message contains "timeout"

### Requirement: Emit one event per query

Each call SHALL emit a `search.query` event with `layer:'L2'`, `durationMs` set to round-trip time, and `payload` containing `query` (truncated to ≤80 chars), `resultCount`, and `topUrl` (or `error` if the call failed).

#### Scenario: Query emits an event

- **WHEN** `searxngClient.query('AI privacy')` resolves with 8 results
- **THEN** exactly one event with `kind='search.query'` is appended to `.sheldon/events.jsonl`
- **AND** the event payload includes `resultCount: 8` and a `topUrl` field
