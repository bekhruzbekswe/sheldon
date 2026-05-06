## Why

Sheldon is meant to run for hours unattended. Real machines crash, sleep, get unplugged, lose Wi-Fi, hit OOM, run into transient Cloudflare 524s that bubble up unhandled. If a 5-hour run dies at hour 3, the user shouldn't lose 3 hours of work.

L3–L5 already persist everything important to SQLite (`facts`, `frontier`, `run_state`). L7's job is mostly **the entrypoint** that recognizes a partial run and makes resuming it the obvious thing to do. Plus a small amount of cleanup: questions that were `in-progress` when the process died need to go back to `pending` so the next loop iteration can pop them.

## What Changes

- New `resume` module (`src/resume.ts`) exporting:
  - `detectInterruptedRun()` — returns a `RunState | null`. A run is "interrupted" if `run_state.phase != 'done'` and `Date.now() < deadline_at + GRACE_MS` (grace = 24h after deadline; older rows are stale).
  - `resetInProgressFrontier()` — sets all `frontier` rows with `status='in-progress'` back to `status='pending'`. Returns the reset count.
  - `clearAll()` — deletes `.sheldon/sheldon.db`, `.sheldon/events.jsonl`, and `.sheldon/last-summary.md`. For `--fresh`.
- New CLI flags on `bun run research`:
  - `--resume` — explicitly resume the interrupted run. Errors if there isn't one.
  - `--fresh` — wipe state before starting. Skips the prompt.
  - With neither flag and an interrupted run present: print a one-line summary ("Found interrupted run … from N hours ago, deadline T. Use `--resume` to continue, `--fresh` to wipe.") and exit 1. Non-interactive friendly.
  - `--kill-after <duration>` — debug flag that throws an uncatchable error after the given duration, simulating a crash. Used for resume testing.
- Resume path in `runResearch`:
  - If resuming, skip `runStart` and `seedFrontier` (those are first-run only). Read the existing `run_state`, reset in-progress rows, restore the phase machine's cache, and re-enter the main loop.
  - If `Date.now() > deadline_at` on resume, the phase machine reads `'synthesis'` immediately and the loop exits to synthesis directly — exactly what we want.
- New event kinds: `resume.detected`, `resume.applied`.

Out of scope: multi-machine resume, cloud sync, deadline extension, branching alternate timelines, in-flight HTTP cancellation/recovery (any in-flight request at crash time is just a lost iteration; we re-pop the question on resume).

## Capabilities

### New Capabilities

- `resume`: Detect an interrupted run from disk state, optionally clear it, restore in-progress queue rows to pending, and provide the orchestration glue so `runResearch` can re-enter mid-run instead of starting fresh.

### Modified Capabilities

- `event-log`: extend `EventKind` with `'resume.detected' | 'resume.applied'`.
- `run-state`: gain a `getRunState`-derived helper `isInterrupted()` that returns true when `phase != 'done'` and the deadline grace window hasn't passed.
- `phase-machine`: `runStart` is now opt-in for the orchestrator (resume path skips it). The phase-machine in-memory `lastSeenPhase` cache MUST initialize from the persisted `run_state.phase` when the orchestrator is resuming, so the first phase-transition emit on resume correctly fires (or doesn't) relative to the actual prior phase.
- `frontier-queue`: gains `resetInProgress()` returning the reset count. (Implementation may live in `resume.ts` rather than `frontier.ts` — either is acceptable as long as the spec requirement is met.)

## Impact

- Code: new `src/resume.ts`. Modifies `src/run.ts` (CLI flags, resume orchestration), `src/research.ts` (`runResearch` accepts a resume flag, skips `runStart`/`seedFrontier` when set), `src/phase.ts` (`runStart` becomes optional in resume path; `lastSeenPhase` seedable from disk), `src/frontier.ts` (or new module) for `resetInProgress`, `src/events.ts` (kinds).
- Dependencies: none.
- Storage: no schema changes. Existing tables/files are the source of truth.
- CLI: `bun run research "<task>" --deadline 2h` (first run), `bun run research --resume` (continue), `bun run research --fresh "<task>" --deadline 2h` (clobber + start over).
