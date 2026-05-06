## Why

L4 stops at a fixed iteration cap. The actual product is "give the agent a deadline (e.g. 5 hours), walk away, come back to a finished result." L5 introduces wall-clock time as the real budget and a **phase machine** that automatically shifts behavior across breadth → depth → synthesis as time passes.

When the synthesis phase fires (default at T+80% of the budget), the agent stops launching new searches/scrapes — even if the frontier has good leads pending. It commits to working only with what it already has. Resuming or extending is L7's concern.

## What Changes

- New `phase-machine` module exposing `phaseMachine.now()` which computes the current phase from `Date.now()` against the persisted `deadline_at`. No `setTimeout` reliance — phase is always re-derivable from clock+budget, so a crash + resume in L7 picks up the right phase automatically.
- New `run_state` SQLite table (singleton row) storing `task`, `started_at`, `deadline_at`, `phase`. Persisted on every transition.
- Deadline parser accepting `5h`, `90m`, `30s`, `500ms`, ISO-8601 strings (`2026-05-05T18:00`). Throws on past, garbage, or <60s deadlines.
- New CLI flag `--deadline <duration>` on `bun run research`. Replaces `--max-iters` as the primary stopping condition (we keep `--max-iters` as a hard cap for safety; default = unlimited when deadline is set).
- Phase-aware scoring: in `breadth` phase the scorer up-weights novelty (0.5) and uses a sharper depth penalty (`0.7^depth`). In `depth` phase it down-weights novelty (0.15) and inverts depth into a bonus (`min(1, 1.05^depth) - capped`). In `synthesis` phase scoring is irrelevant (loop exits).
- Phase checkpoints at every async step inside an iteration: between search → scrape → per-source indexing → propose. As soon as `phaseMachine.now() === 'synthesis'`, the iteration short-circuits with whatever it has, the popped question is marked done with partial results (or skipped if nothing landed yet), and the loop exits.
- New event kinds: `phase.transition` (one event per breadth→depth and depth→synthesis flip), `run.start`, `run.end`.
- The L4 `--max-iters` flag is preserved as an optional safety cap; default removed (deadline is the primary stopper).

Out of scope: synthesis logic itself (L6 will read `run_state.phase === 'synthesis'` and trigger writing the report), resume/restart (L7), runtime adjustment of deadline.

## Capabilities

### New Capabilities

- `phase-machine`: Pure clock-derived state machine returning `'breadth' | 'depth' | 'synthesis'` for any moment. Configurable phase boundaries (defaults 30%/50%/20%). Persists transitions to `run_state` and emits `phase.transition` events.
- `run-state`: SQLite-backed singleton row (`id=1` enforced via CHECK) storing the active run's task, start/deadline timestamps, and current phase. Created on first `runStart` call; updated on phase transitions and on `runEnd`.

### Modified Capabilities

- `scorer`: gain a `phase` parameter on `score()` that adjusts coefficients and depth-decay base. Pure function still.
- `event-log`: extend `EventKind` union with `'phase.transition' | 'run.start' | 'run.end'`.
- `frontier-queue`: no schema change, but `pop()` SHALL refuse to return a row when the run state is in `synthesis` phase (returns null). This makes accidental work-after-deadline impossible at the data-access layer.

## Impact

- Code: new `src/phase.ts` (phase-machine + deadline parser + run-state helpers). Modifies `src/db.ts` (add `run_state` table), `src/score.ts` (phase parameter), `src/research.ts` (replace iteration loop with phase-driven loop), `src/run.ts` (CLI flag), `src/frontier.ts` (refuse pop in synthesis phase), `src/events.ts` (new kinds), `src/inspect.ts` (optionally show current phase + time-remaining).
- Dependencies: none.
- Storage: new `run_state` table. Existing tables untouched.
- CLI: `bun run research "<task>" --deadline <duration>` is the primary new entrypoint. `--max-iters N` remains available as a safety cap.
