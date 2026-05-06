# Tasks

## 1. Extend event taxonomy

- [x] 1.1 Added `'resume.detected' | 'resume.applied'` to `EventKind`

## 2. Resume module

- [x] 2.1 `src/resume.ts` exports `detectInterruptedRun`, `resetInProgressFrontier`, `clearAll`, `RESUME_GRACE_MS`
- [x] 2.2 `detectInterruptedRun`: null if no row, phase='done', or beyond 24h grace; else returns the row
- [x] 2.3 `resetInProgressFrontier`: single SQL UPDATE, returns rowsChanged
- [x] 2.4 `clearAll`: removes db (+ wal/shm), events.jsonl, last-summary.md; preserves reports/

## 3. Phase-machine cache seeding

- [x] 3.1 `seedPhaseCache(phase)` exported from `src/phase.ts`; sets `lastSeenPhase` without emitting

## 4. Research loop resume support

- [x] 4.1 `ResearchOptions.resume?: boolean` added
- [x] 4.2 Resume path skips `runStart` and `seedFrontier`
- [x] 4.3 Resume path calls `resetInProgressFrontier` then `seedPhaseCache(state.phase)` (mapping 'done' → 'synthesis' since `Phase` union excludes 'done')
- [x] 4.4 Emits `resume.applied` with `{questionsResetCount, currentPhase, factsBefore, frontierBefore}`
- [x] 4.5 `runEnd` still fires from the existing `finally` block on resume

## 5. CLI flags

- [x] 5.1 `--resume`, `--fresh`, `--kill-after <duration>` added to `src/run.ts`
- [x] 5.2 `--fresh` calls `clearAll()`, then proceeds normally
- [x] 5.3 `--resume` uses `detectInterruptedRun()`; errors out if none
- [x] 5.4 `--resume` doesn't require task or `--deadline` (reads from saved state)
- [x] 5.5 No flags + interrupted run present → prints helpful message + exits 1
- [x] 5.6 `--kill-after` schedules `process.exit(137)` via `setTimeout`
- [x] 5.7 Resume path prints "Resuming run … phase=… deadline in …" to stderr
- [x] 5.8 `resume.detected` event emitted on resume CLI invocation

## 6. Smoke test

- [x] 6.1 `bun run typecheck` clean
- [x] 6.2 `bun run research "..." --deadline 5m --seeds 3 --kill-after 75s` exited 137 mid-iteration; persisted state showed 29 facts, 1 in-progress + 2 pending frontier rows, run_state.phase='breadth'
- [x] 6.3 `bun run research "different task" --deadline 5m` (no resume flag) correctly refused with helpful message + exit 1
- [x] 6.4 `bun run research --resume --kill-after 60s` re-detected, reset 1 in-progress row, re-popped same question, fired `phase.transition breadth→depth` naturally; ran 60s; killed; final state 33 facts (4 new), 1 in-progress + 2 pending
- [x] 6.5 `bun run research --fresh "test" --deadline 60s --kill-after 2s` wiped everything except `reports/old.md` (preserved)
- [x] 6.6 Event log showed `resume.detected` and `resume.applied` exactly once each on the resume run

## 7. Validate, document, archive

- [x] 7.1 `openspec validate add-resume` passes
- [ ] 7.2 Update `README.md` Status line and layer index (L7 done)
- [ ] 7.3 Update `AGENTS.md` layer-status table (L7 done)
- [ ] 7.4 `openspec archive add-resume --yes`
- [ ] 7.5 Verify all new specs and `event-log` updated
