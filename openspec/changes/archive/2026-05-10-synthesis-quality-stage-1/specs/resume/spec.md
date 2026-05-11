# resume Specification (delta)

## MODIFIED Requirements

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
