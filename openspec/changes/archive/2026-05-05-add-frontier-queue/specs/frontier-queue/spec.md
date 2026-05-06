## ADDED Requirements

### Requirement: SQLite-backed frontier table

The frontier queue SHALL persist to the same `.sheldon/sheldon.db` used by the fact store. On first use it MUST run idempotent CREATE statements creating a `frontier` table with columns: `id INTEGER PK AUTOINCREMENT`, `question TEXT NOT NULL`, `score REAL NOT NULL`, `status TEXT NOT NULL`, `parent_id INTEGER`, `depth INTEGER NOT NULL`, `embedding BLOB NOT NULL`, `created_at INTEGER NOT NULL`, `processed_at INTEGER`. An index MUST cover `(status, score DESC)` for efficient prioritized pop.

#### Scenario: Schema is created on first use

- **GIVEN** `.sheldon/sheldon.db` exists from L3 but has no `frontier` table
- **WHEN** any `frontier` method is called
- **THEN** the `frontier` table exists with the documented columns
- **AND** the `idx_frontier_status_score` index exists

### Requirement: Push a question with novelty dedupe

The `frontier.push(input)` function SHALL accept `{question, score, parentId?, depth, embedding}` and insert a new row with `status='pending'`. Before inserting, the function MUST compute cosine similarity between the candidate's embedding and the embedding of every existing row (regardless of status). If the maximum similarity is ≥ 0.85, the function MUST skip the insert, emit a `frontier.dedupe` event referencing the matched id, and return `null`. On successful insert it MUST emit a `frontier.push` event and return the new row id.

#### Scenario: Distinct question is added

- **GIVEN** the frontier has 5 questions, none similar to "EU AI Act timeline"
- **WHEN** `frontier.push({question:'EU AI Act timeline', score:0.7, depth:1, embedding:e})` is called
- **THEN** the function returns a positive integer id
- **AND** one `frontier.push` event has been emitted

#### Scenario: Near-duplicate is rejected

- **GIVEN** the frontier already contains a question whose embedding has cosine 0.92 to the candidate
- **WHEN** `frontier.push(...)` is called
- **THEN** the function returns `null`
- **AND** one `frontier.dedupe` event has been emitted referencing the matched row's id and the similarity

### Requirement: Pop the highest-scored pending question

The `frontier.pop()` function SHALL atomically transition the highest-scored `status='pending'` row to `status='in-progress'`, set `processed_at = Date.now()`, emit a `frontier.pop` event, and return the row. If no pending rows exist, it MUST return `null`. The transition MUST happen in a single transaction so concurrent calls cannot pop the same row.

#### Scenario: Highest-scored pending row is selected

- **GIVEN** pending rows with scores [0.6, 0.9, 0.7]
- **WHEN** `frontier.pop()` is called
- **THEN** the function returns the row with score 0.9
- **AND** that row's `status` is now `'in-progress'`
- **AND** one `frontier.pop` event has been emitted

#### Scenario: Empty queue returns null

- **GIVEN** no rows have `status='pending'`
- **WHEN** `frontier.pop()` is called
- **THEN** the function returns `null`

### Requirement: Mark a question done or skipped

The `frontier.markDone(id, outcome?)` function SHALL set `status='done'` and emit a `frontier.done` event with payload containing the row id and a snapshot of `{factsAdded, claimsExtracted}` from `outcome`. The `frontier.markSkipped(id, reason)` function SHALL set `status='skipped'` and emit a `frontier.skip` event whose payload includes the reason string.

#### Scenario: Done state is persisted

- **WHEN** `frontier.markDone(42, {factsAdded: 7, claimsExtracted: 12})` is called
- **THEN** row 42 has `status='done'`
- **AND** one `frontier.done` event has been emitted with `payload.factsAdded: 7`

### Requirement: List pending questions for context-building

The `frontier.listPending(limit?)` function SHALL return up to `limit` (default 5) rows with `status='pending'`, ordered by `score DESC`. Embedding columns MAY be omitted to keep the payload small. This is used by the followup-proposer to summarize the current frontier without spending too many context tokens.

#### Scenario: Returns top 5 pending titles

- **GIVEN** the frontier has 12 pending rows
- **WHEN** `frontier.listPending()` is called
- **THEN** the result has length 5
- **AND** entries are sorted by `score` descending
