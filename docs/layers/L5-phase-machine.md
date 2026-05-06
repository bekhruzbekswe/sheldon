# L5 — Time budget + phases

## Goal

Replace L4's "stop after 30 iterations" with the real product: a wall-clock deadline. Add a **phase machine** that automatically shifts the agent's behavior across breadth → depth → synthesis as the clock ticks. When the synthesis trigger fires, search/scrape/extract is locked off — the agent commits to working only with what it already has.

After this layer, you can give the agent a 5-hour deadline, walk away, and trust it to wrap up on time.

## Capabilities introduced

- `phase-machine` — tracks current phase (`breadth` | `depth` | `synthesis`), exposes `phaseRunner.now()`, fires phase transitions on schedule
- `deadline-tracker` — wall-clock timer that flips `phase-machine` flags at configured percentages of total budget
- Phase-aware scoring: `breadth` favors novelty (push wide), `depth` favors deepening promising threads (parent_id chain bonus)

## Dependencies

- L0 / `llm-client`
- L1 / `event-log`
- L2 / `search-loop`
- L3 / `fact-store`
- L4 / `frontier-queue`, `scorer`

## Key data structures / decisions

**Phase boundaries (defaults, configurable):**
- `breadth`: T+0 → T+30%
- `depth`: T+30% → T+80%
- `synthesis`: T+80% → T+100%

For a 5-hour run that means: 1.5h breadth, 2.5h depth, 1h synthesis. These are the numbers from the explainer; revisit after first real run.

**State persisted to SQLite:**
```sql
CREATE TABLE run_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),  -- singleton row
  task TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  deadline_at INTEGER NOT NULL,
  phase TEXT NOT NULL                     -- 'breadth' | 'depth' | 'synthesis' | 'done'
);
```

L7 (resume) needs this row to know how to pick up.

**Phase-aware scoring:**
- Breadth: bias toward `novelty` weight (0.6 instead of 0.3); penalize deep nodes more aggressively (`0.7 ** depth` instead of `0.9 ** depth`).
- Depth: invert — bias toward depth (`1.05 ** depth` reward), reduce novelty weight.
- Synthesis: no scoring — main loop exits, synthesis loop takes over (defined in L6).

**Loop check:**
```ts
while (true) {
  const phase = phaseMachine.now();
  if (phase === 'synthesis') break;     // L6 takes over
  const q = frontier.pop(phase);
  if (!q) await sleep(...);             // queue empty mid-phase, give it a beat
  await processQuestion(q);
}
```

**Deadline arming:** at run start, set up `setTimeout` for each phase boundary that just flips the flag in `run_state`. Loop reads the flag every iteration. No setTimeout in production for synthesis trigger if we're worried about reliability — instead, `phaseMachine.now()` computes from `Date.now()` against `deadline_at`, so it's correct even after a crash + resume mid-phase.

**Deadline parsing CLI:** `--deadline 5h`, `--deadline 90m`, `--deadline 2026-05-05T18:00`. Parser is small; validate at startup, throw on garbage.

## Out of scope

- Synthesis phase logic itself (that's L6)
- Resume/restart behavior (L7) — though we persist the state row that L7 needs
- User-facing time UI (L8 or never)

## Open questions

- Are the 30/50/20 percentages right? Probably tuneable; expose as flags.
- What if the user gives a deadline that's already passed or less than 1 minute in the future? Throw at startup.
- Should we have a `cooldown` mini-phase between depth and synthesis (e.g. 5 min) where in-flight scrapes can finish? **Tentative:** no, abort in-flight on phase transition. Simpler. If we lose a few claims, fine.
