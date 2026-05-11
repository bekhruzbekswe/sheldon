# resume Specification

## Purpose

Crash-recovery primitives. `detectInterruptedRun()` reads SQLite to spot a previous run that didn't reach `phase='done'` and is within a 24h grace window. `resetInProgressFrontier()` undoes the one piece of mid-iteration state that's not safely committed (questions popped but not yet marked done/skipped). `clearAll()` wipes working state for `--fresh` while preserving `.sheldon/reports/`. The orchestration glue lives in `runResearch` (gains a `resume` flag) and the CLI (gains `--resume`/`--fresh`/`--kill-after`).

## Requirements
### Requirement: Detect interrupted runs

The `detectInterruptedRun()` function SHALL return the existing `RunState` row if `run_state.phase` is anything other than `'done'` AND `Date.now() < run_state.deadline_at + 24*3600*1000` (a 24-hour grace window after the deadline). Otherwise it MUST return `null`. The function MUST NOT mutate any state.

#### Scenario: Active interrupted run is detected

- **GIVEN** a `run_state` row with `phase='depth'` and `deadline_at` 30 minutes in the future
- **WHEN** `detectInterruptedRun()` is called
- **THEN** the function returns that row (`phase='depth'`)

#### Scenario: Recently expired run still detected within grace

- **GIVEN** a `run_state` row with `phase='synthesis'` and `deadline_at` 10 minutes in the past
- **WHEN** `detectInterruptedRun()` is called
- **THEN** the function returns that row

#### Scenario: Done run not interrupted

- **GIVEN** a `run_state` row with `phase='done'`
- **WHEN** `detectInterruptedRun()` is called
- **THEN** the function returns `null`

#### Scenario: Stale run beyond grace window

- **GIVEN** a `run_state` row with `phase='breadth'` and `deadline_at` 30 hours in the past
- **WHEN** `detectInterruptedRun()` is called
- **THEN** the function returns `null`

### Requirement: Reset in-progress frontier rows on resume

The `resetInProgressFrontier()` function SHALL update every `frontier` row with `status='in-progress'` to `status='pending'`. It MUST return the count of rows reset. It MUST NOT touch rows with any other status.

#### Scenario: Two in-progress rows are reset

- **GIVEN** the frontier has rows with statuses `[pending, pending, in-progress, in-progress, done, skipped]`
- **WHEN** `resetInProgressFrontier()` is called
- **THEN** the return value is `2`
- **AND** statuses are now `[pending, pending, pending, pending, done, skipped]`

### Requirement: Clear all on --fresh

The `clearAll()` function SHALL reset the run-scoped state in `.sheldon/sheldon.db` and remove the side-channel files, while preserving the cross-run caches and the past reports directory. Specifically:

1. Open the database via `getDb()` and execute, in a single transaction, `DELETE FROM facts`, `DELETE FROM frontier`, `DELETE FROM run_state`. The `sources` table MUST NOT be touched (it is a cross-run classification cache; preserving it is the whole point of the schema split).
2. Delete `.sheldon/events.jsonl` and `.sheldon/last-summary.md` if they exist.
3. MUST NOT touch the `.sheldon/reports/` directory (past reports stay).
4. MUST NOT delete or unlink the `.sheldon/sheldon.db` file itself. (Behavior change from v1, where the file was unlinked; that path is gone.)

The function MUST be safe to call when any individual file or table is missing.

#### Scenario: Wipe leaves reports and sources cache intact

- **GIVEN** all of the following exist: rows in `facts`, `frontier`, `run_state`, `sources`; files `.sheldon/events.jsonl`, `.sheldon/last-summary.md`, `.sheldon/reports/old.md`
- **WHEN** `clearAll()` is called
- **THEN** `facts`, `frontier`, and `run_state` are empty
- **AND** the `sources` table still contains the same rows it had before
- **AND** `.sheldon/events.jsonl` and `.sheldon/last-summary.md` no longer exist
- **AND** `.sheldon/reports/old.md` still exists
- **AND** `.sheldon/sheldon.db` (the file) still exists

#### Scenario: clearAll is safe on a partially-populated state

- **GIVEN** `.sheldon/events.jsonl` does not exist, but `.sheldon/sheldon.db` does
- **WHEN** `clearAll()` is called
- **THEN** the function does not throw
- **AND** the `facts`, `frontier`, and `run_state` tables become empty

#### Scenario: clearAll does not produce SQLITE_IOERR_VNODE in the dashboard

- **GIVEN** the dashboard process holds a `Database` handle open against `.sheldon/sheldon.db`
- **WHEN** `clearAll()` runs in the writer process
- **THEN** the dashboard's existing handle remains valid (the file's vnode has not changed)
- **AND** subsequent dashboard queries succeed without needing `resetDb()` to recover from `SQLITE_IOERR_VNODE`

### Requirement: Resume path skips runStart and seedFrontier

When `runResearch` is invoked with `{resume: true}`, it MUST NOT call `runStart` (the row already exists) and MUST NOT call `seedFrontier` (seeds were created on the original run). It MUST call `resetInProgressFrontier()` before entering the main loop. It MUST emit one `resume.applied` event with `payload` containing `{questionsResetCount, currentPhase, factsBefore, frontierBefore}`.

#### Scenario: Resumed run does not re-seed

- **GIVEN** an interrupted run with 12 frontier rows (some pending, some done)
- **WHEN** `runResearch(task, {resume: true})` runs the main loop once
- **THEN** the frontier still has exactly 12 rows (no fresh seeds added)
- **AND** one `resume.applied` event has been emitted

### Requirement: Resume restores phase-machine cache from persisted state

On the resume path, the phase-machine's in-memory `lastSeenPhase` cache MUST be set from `run_state.phase` BEFORE the first call to `phaseMachine.now()`. This prevents spurious `phase.transition` events that would otherwise fire when the cache (default `null`) first observes the persisted phase.

#### Scenario: Resume from depth does not emit phase.transition for breadth->depth

- **GIVEN** an interrupted run with `run_state.phase='depth'`
- **WHEN** `runResearch(task, {resume: true})` runs and the loop calls `phaseMachine.now()` for the first time
- **THEN** no `phase.transition` event with `from='breadth'` is emitted
- **AND** if the live phase is still `'depth'`, no `phase.transition` event fires at all

