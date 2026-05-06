# Tasks

## 1. Extend event taxonomy

- [x] 1.1 Added `'phase.transition' | 'run.start' | 'run.end'` to `EventKind` in `src/events.ts`
- [x] 1.2 `Layer` already includes `'L5'`

## 2. Database schema

- [x] 2.1 Added `run_state` singleton table (CHECK id=1) to `src/db.ts` CREATE block

## 3. Phase machine + deadline parser

- [x] 3.1 `src/phase.ts` exports BREADTH_END=0.30, DEPTH_END=0.80, MIN_DEADLINE_MS=60_000
- [x] 3.2 `parseDeadline(input, now)` handles `Ns/Nm/Nh/Nms`, ISO-8601; rejects past/garbage/<60s
- [x] 3.3 `runStart(task, deadlineAt)` upserts singleton row, resets cache, emits `run.start`
- [x] 3.4 `getRunState(): RunState | null`
- [x] 3.5 `phaseMachine.now()` derives phase from `Date.now()` against persisted timestamps
- [x] 3.6 Caches `lastSeenPhase`, emits one `phase.transition` per genuine boundary; **walks intermediate phases when a single observation skips multiple boundaries** (breadth → synthesis without observing depth would otherwise lose the depth event)
- [x] 3.7 `runEnd(stats)` updates row to `phase='done'`, emits `run.end`

## 4. Phase-aware scoring

- [x] 4.1 `ScoreInput` gained optional `phase`
- [x] 4.2 Breadth: `0.4*r + 0.5*n + 0.1 * 0.7^d`
- [x] 4.3 Depth: `0.5*r + 0.15*n + 0.35 * min(1.5, 1.0 + 0.05*d)`
- [x] 4.4 Synthesis returns 0
- [x] 4.5 Default = breadth (existing call sites unchanged)

## 5. Frontier pop honors synthesis lock

- [x] 5.1 `frontier.pop()` calls `getRunState()`/`phaseMachine.now()` and returns null in synthesis

## 6. Wire phase machine into research loop

- [x] 6.1 `runResearch` calls `runStart` first, runs in try/finally with `runEnd`
- [x] 6.2 Loop condition uses `phaseMachine.now() !== 'synthesis' && iterations < maxIters`
- [x] 6.3 `processIteration` checkpoints after search, after scrape, between sources, before propose
- [x] 6.4 Seeding uses current phase
- [x] 6.5 Followup pushes use current phase in score()
- [x] 6.6 `runResearch` accepts `deadlineAt`; defaults to 24h-from-now when omitted (preserves L4 behavior under `--max-iters`-only)

## 7. CLI

- [x] 7.1 `--deadline <duration>` flag
- [x] 7.2 Parses + prints deadline timestamp
- [x] 7.3 Default `--max-iters 10` if neither set
- [x] 7.4 No `--max-iters` cap when only `--deadline` is set
- [x] 7.5 Final summary includes `phaseReached` and `elapsedMs`

## 8. Inspect upgrade

- [x] 8.1 `bun run inspect --frontier` shows `run_state` header (task, phase, time remaining)

## 9. Smoke test

- [x] 9.1 `bun run typecheck` clean
- [x] 9.2 `rm -rf .sheldon && bun run research "What is RAG in plain terms?" --deadline 90s --seeds 3 --max-iters 5` ran end-to-end
- [x] 9.3 Both phase transitions fired (breadth→depth at 46.3s, depth→synthesis observed at 326.7s due to checkpoint lag inside indexSource)
- [x] 9.4 `run.start` and `run.end` events fired exactly once each
- [x] 9.5 `frontier.pop` refused to return the 2 pending rows after synthesis trigger (the in-flight iteration's question was marked skipped, the others stayed pending)
- [x] 9.6 `bun run inspect --frontier` shows the run_state header with `phase=done`

## 10. Validate, document, archive

- [x] 10.1 `openspec validate add-phase-machine` passes
- [ ] 10.2 Update `README.md` Status line and layer index (L5 done)
- [ ] 10.3 Update `AGENTS.md` layer-status table (L5 done)
- [ ] 10.4 `openspec archive add-phase-machine --yes`
- [ ] 10.5 Verify all new specs created and modified specs reflect changes
