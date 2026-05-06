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

The `clearAll()` function SHALL delete `.sheldon/sheldon.db`, `.sheldon/events.jsonl`, and `.sheldon/last-summary.md` if any of them exist. It MUST NOT touch the `.sheldon/reports/` directory (past reports stay).

#### Scenario: Wipe leaves reports intact

- **GIVEN** all of `.sheldon/sheldon.db`, `events.jsonl`, `last-summary.md`, and `reports/old.md` exist
- **WHEN** `clearAll()` is called
- **THEN** the first three files no longer exist
- **AND** `.sheldon/reports/old.md` still exists

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

