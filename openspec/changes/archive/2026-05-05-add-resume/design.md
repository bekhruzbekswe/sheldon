## Context

L3–L5 already do the hard part of L7. Every meaningful piece of state lives in SQLite (`facts`, `frontier`, `run_state`) which is durable through process death. The only thing missing is:

1. The **detection** at startup — "is there an interrupted run?"
2. A small amount of **cleanup** on resume — `frontier` rows that were `in-progress` at the moment of crash need to go back to `pending`.
3. The **flow control** in `runResearch` — a resume-mode that skips the once-per-run setup (decompose seeds, runStart) and re-enters the iteration loop directly.
4. **Phase-cache seeding** so the resumed run doesn't fire a fake `phase.transition` from the default cache value.

That's it. No schema changes, no new primitives.

## Goals / Non-Goals

**Goals**

- Crash anywhere → `bun run research --resume` continues
- Zero double-billing of work (no re-running done iterations)
- No data loss for already-written facts/frontier rows
- Stale runs (>24h past deadline) are not auto-detected — they're treated as old garbage
- A debug `--kill-after Ns` flag for testing the recovery path

**Non-goals**

- Multi-machine resume (one machine, one DB file)
- Cloud sync of the database (user's job)
- Deadline extension on resume (would defeat the discipline)
- In-flight HTTP request recovery — at-most-one-iteration loss is acceptable
- Branching alternate timelines

## Decisions

### Decision 1: 24-hour grace window after deadline

**Why**: A run that ended in synthesis but never hit `runEnd` (process killed mid-synthesis) leaves `run_state.phase != 'done'` and `Date.now() > deadline_at`. We want to be able to resume that for a reasonable window — say, the user came back from the gym, saw the partial state, wants to pick up. 24h is generous but not so long that month-old DBs get accidentally resumed.

**Alternatives considered**:
- No grace (resume only if before deadline) — too strict; misses the common "synthesis crashed" case.
- Forever (always resumable) — too lenient; old DBs lying around get reanimated.

### Decision 2: `resetInProgressFrontier` is the only state cleanup needed

**Why**: Audit of L3–L5:

- `facts`: every `factStore.insert` is one SQLite statement; either committed or not. No partial states. No cleanup needed.
- `frontier.push`: same — one statement. No cleanup needed.
- `frontier.pop` (with `markDone`/`markSkipped`): pop transitions to `in-progress` in a transaction; mark transitions to `done`/`skipped` as a separate write. **Crash window**: between pop and mark. The popped row stays `in-progress` forever otherwise. Solution: reset to `pending` on resume so the question gets re-tried.
- `run_state.phase`: persisted on every transition. The resumed phase machine reads from disk. Cache-seeding (Decision 4) handles initialization.
- `events.jsonl`: append-only; lossy at the partial last line. The watch reader skips unparseable lines.

That's the entire crash-safety audit. Resume is one SQL UPDATE statement away from correct.

### Decision 3: Default-explicit prompt rather than auto-resume

**Why**: I considered making `bun run research` (no flags) auto-resume when an interrupted run exists. That feels magical and surprising — if a user fires `bun run research "new task"` they probably want a new task, not their old one continuing. Better to require explicit `--resume` (or `--fresh "new task"`).

When neither flag is set and an interrupted run exists, we print a helpful message and exit 1 — non-zero exit so scripts notice, message tells the human what to do.

### Decision 4: Seed `lastSeenPhase` from persisted phase before first `now()` call

**Why**: Without this, a resume from `phase='depth'` would have `lastSeenPhase = null` (default) → first `phaseMachine.now()` call sees the cache differs from current → fires `phase.transition` from `'breadth'` (the array-walk default). That's a phantom transition that didn't actually happen.

The seed is one line: `lastSeenPhase = runState.phase`. Done before the loop starts.

### Decision 5: `--kill-after` is a top-level CLI flag, not a config

**Why**: It's a debug primitive used exactly when testing the resume path. Discoverable via `--help`. Implementation is a `setTimeout(() => process.exit(137), ms)` after `runStart` runs. That hard-exits the process without unwinding `finally` blocks, simulating a SIGKILL — the worst-case crash scenario we need recovery from.

### Decision 6: `clearAll()` preserves `.sheldon/reports/`

**Why**: Past reports are valuable historical artifacts. A `--fresh` should clobber working state, not throw away the past. The user can `rm -rf .sheldon/reports/` themselves if they want a truly clean slate.

### Decision 7: No automatic deadline extension on resume

**Why**: If the deadline passes during the crash, resume jumps to synthesis (because `phaseMachine.now()` reads `'synthesis'` immediately). That's the correct behavior — if they wanted more time they should have scheduled more. We don't bolt on a `--extend 1h` flag in v1; if real users ask for it, easy add.

## Risks / Trade-offs

- **[Risk] Crash mid-`fact.insert` leaves an orphaned dedup-check.** → Single-statement INSERT is atomic; no risk in practice.
- **[Risk] Crash between `frontier.pop` and `markSkipped` orphans the row in-progress.** → Exactly the case `resetInProgressFrontier` handles.
- **[Risk] Two terminal sessions running `bun run research --resume` simultaneously.** → Both reset in-progress; both pop the same row; one's transaction wins; the other gets the next-best. SQLite handles the locking. Suboptimal but not corrupting.
- **[Risk] `--kill-after` runs in a context where exit code 137 isn't honored.** → Acceptable; this is a debug flag.
- **[Trade-off] Resume can't re-attempt a particular iteration that errored.** → Erroring iterations get marked `skipped` and stay there. If the user wants to retry, they manually update the DB. Documented; acceptable.

## Migration Plan

Additive. `bun run research "<task>" --deadline 5h` works as before. Resume is a new flag; existing scripts keep running.

The only tricky compatibility question: existing `.sheldon/sheldon.db` files from before L7 contain `run_state` rows with `phase='done'` (because we always set that on `runEnd`). Those should NOT be detected as interrupted. The detection rule (`phase != 'done'`) handles this correctly.

## Open Questions

- Should we automatically clean up old `phase='done'` `run_state` rows? **Decided**: not in L7. The singleton CHECK constraint means a new `runStart` clobbers the row anyway.
- Should resume confirm with the user before continuing (e.g. show summary of frontier state, ask y/N)? **Decided**: no — `--resume` is the explicit confirmation. Print the resumed state to stderr so it's visible.
- What about resuming a run with a different LLM endpoint configuration? **Decided**: out of scope. The user takes responsibility for not changing `.env` mid-run.
