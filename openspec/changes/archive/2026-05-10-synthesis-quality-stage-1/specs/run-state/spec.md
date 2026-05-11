# run-state Specification (delta)

## MODIFIED Requirements

### Requirement: Singleton run_state row in SQLite

The `run_state` table SHALL exist with columns `id INTEGER PRIMARY KEY CHECK (id = 1)`, `task TEXT NOT NULL`, `started_at INTEGER NOT NULL`, `deadline_at INTEGER NOT NULL`, `phase TEXT NOT NULL`, `contract_json TEXT`, `task_embedding BLOB`. The CHECK constraint MUST enforce that at most one row can ever exist. The schema MUST be created idempotently in `getDb()`'s init block. The two new columns (`contract_json`, `task_embedding`) MAY be NULL during the brief window between `INSERT OR REPLACE` and the contract-drafter / embedder finishing — readers (`getRunState()`) MUST tolerate NULL on those fields.

#### Scenario: Schema created on first DB open

- **GIVEN** a freshly-created `.sheldon/sheldon.db`
- **WHEN** `getDb()` runs
- **THEN** the `run_state` table exists with all seven columns
- **AND** the CHECK constraint rejects any insert with `id != 1`

#### Scenario: Reader tolerates partially-populated row

- **GIVEN** a `run_state` row with non-null `task`, `started_at`, `deadline_at`, `phase` but null `contract_json` and `task_embedding`
- **WHEN** `getRunState()` is called
- **THEN** the function returns an object with `task`, `startedAt`, `deadlineAt`, `phase` populated
- **AND** `contract` is `null` and `taskEmbedding` is `null`

### Requirement: runStart writes the singleton row

The `runStart(task, deadlineAt)` function SHALL insert (or replace) the singleton row with `id=1`, the given task, `started_at = Date.now()`, the given `deadlineAt`, and `phase = 'breadth'`. Within the same call (after the row insert), it MUST: (a) embed the task via `embedder.embed([task])` and update the row's `task_embedding` BLOB to the resulting Float32 little-endian bytes, (b) draft the research contract via the contract module and update `contract_json` with the resulting JSON string. The function MUST emit one `run.start` event with payload `{task, deadlineAt, durationMs}` *before* the contract draft (so the dashboard sees the run start promptly even if drafting is slow). The contract drafter emits its own `contract.drafted` event separately.

#### Scenario: Fresh run replaces any prior row and populates new columns

- **GIVEN** the table contains a stale row from a prior run
- **WHEN** `runStart('new task', deadlineAt)` is called and the contract drafter succeeds
- **THEN** the table contains exactly one row with the new task and `started_at = now`
- **AND** the row's `task_embedding` is a non-null BLOB of length `384 * 4`
- **AND** the row's `contract_json` is a non-empty JSON string
- **AND** one `run.start` event has been emitted
- **AND** one `contract.drafted` event has been emitted

#### Scenario: run.start event fires before contract drafting completes

- **WHEN** `runStart(...)` is called
- **THEN** the `run.start` event is emitted to `events.jsonl` before the `contract.drafted` event

### Requirement: getRunState reads the singleton or returns null

The `getRunState()` function SHALL return the current row as `{task, startedAt, deadlineAt, phase, contract: ResearchContract | null, taskEmbedding: Float32Array | null}` or `null` if no row exists. The `contract` field is the parsed JSON object (or null if the column is null or unparseable). The `taskEmbedding` field is a Float32Array of length 384 (or null if the column is null).

#### Scenario: No row returns null

- **GIVEN** the `run_state` table is empty
- **WHEN** `getRunState()` is called
- **THEN** the result is `null`

#### Scenario: Row with full contract returns parsed object

- **GIVEN** the row's `contract_json` is `'{"core_question":"X","sub_questions":[],"good_answer_contains":[],"out_of_scope":[]}'`
- **WHEN** `getRunState()` is called
- **THEN** the returned object's `contract.core_question === 'X'`
- **AND** `contract.out_of_scope` is an empty array
