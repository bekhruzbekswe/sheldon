# run-state Specification

## Purpose

Singleton SQLite-backed row tracking the active research run: task, started_at, deadline_at, and current phase. Lifecycle helpers `runStart` / `runEnd` mark the run boundaries and emit `run.start` / `run.end` events with summary stats. Foundation for L7 resume: a singleton row that survives crashes and contains everything needed to know "where was the agent when it died".

## Requirements
### Requirement: Singleton run_state row in SQLite

The `run_state` table SHALL exist with columns `id INTEGER PRIMARY KEY CHECK (id = 1)`, `task TEXT NOT NULL`, `started_at INTEGER NOT NULL`, `deadline_at INTEGER NOT NULL`, `phase TEXT NOT NULL`. The CHECK constraint MUST enforce that at most one row can ever exist. The schema MUST be created idempotently in `getDb()`'s init block.

#### Scenario: Schema created on first DB open

- **GIVEN** a freshly-created `.sheldon/sheldon.db`
- **WHEN** `getDb()` runs
- **THEN** the `run_state` table exists with the documented columns
- **AND** the CHECK constraint rejects any insert with `id != 1`

### Requirement: runStart writes the singleton row

The `runStart(task, deadlineAt)` function SHALL insert (or replace) the singleton row with `id=1`, the given task, `started_at = Date.now()`, the given `deadlineAt`, and `phase = 'breadth'`. It MUST emit one `run.start` event with payload `{task, deadlineAt, durationMs}`.

#### Scenario: Fresh run replaces any prior row

- **GIVEN** the table contains a stale row from a prior run
- **WHEN** `runStart('new task', deadlineAt)` is called
- **THEN** the table contains exactly one row with the new task and started_at = now
- **AND** one `run.start` event has been emitted

### Requirement: getRunState reads the singleton or returns null

The `getRunState()` function SHALL return the current row as `{task, startedAt, deadlineAt, phase}` or `null` if no row exists.

#### Scenario: No row returns null

- **GIVEN** the `run_state` table is empty
- **WHEN** `getRunState()` is called
- **THEN** the result is `null`

### Requirement: runEnd marks the run as done

The `runEnd(stats)` function SHALL update the singleton row's `phase` to `'done'` and emit one `run.end` event whose payload includes `iterations`, `factsAdded`, `claimsExtracted`, `elapsedMs`, and the final `phase` reached before exit.

#### Scenario: runEnd marks done and emits

- **GIVEN** an active run with `phase='synthesis'`
- **WHEN** `runEnd({iterations: 4, factsAdded: 200, claimsExtracted: 250, elapsedMs: 1500000})` is called
- **THEN** the row's `phase` is `'done'`
- **AND** one `run.end` event has been emitted with those payload fields

