## Context

L4 stops at a fixed iteration cap. L5 replaces that with the actual product behavior: a wall-clock deadline that automatically partitions time into breadth → depth → synthesis. The user's mental model is "I'm going to the gym for 5 hours, come back to a finished report."

Several earlier-decided design points constrain L5:
- All state in `.sheldon/sheldon.db` (so L7 resume works).
- Phase MUST be derivable from clock + budget alone (no setTimeout authoritative state) so a crash mid-phase is recoverable.
- The agent must NOT keep searching after the synthesis trigger fires, even if there are great pending leads. That's a behavioral commitment, not a technical impossibility.

## Goals / Non-Goals

**Goals**

- Wall-clock deadline as primary stopping condition
- Phases derivable purely from `Date.now()` against persisted timestamps (no in-memory authoritative state)
- Phase-aware scoring that meaningfully shifts behavior between breadth and depth
- A clean checkpoint-based abort: when synthesis triggers mid-iteration, finish the current async step then exit cleanly
- Deadline parser that's strict (rejects past, garbage, sub-60s)

**Non-goals**

- Synthesis logic / report writing (L6)
- Resume / crash recovery (L7) — though we lay the persistence groundwork
- Hard-aborting in-flight HTTP via AbortSignal — checkpoint-based is enough; full abort plumbing is L7-or-later
- Mid-run deadline extension via signals (e.g. SIGUSR1)
- User-visible time UI (L8)

## Decisions

### Decision 1: Phase is derived, not stored authoritatively

**Why**: Crashes happen, processes get killed, laptops sleep. If "current phase" lived only in memory, a resume would have to reconstruct it. By making `phaseMachine.now()` a pure function of `Date.now() - started_at` against `deadline_at`, the phase is always correct regardless of process lifecycle. We *do* persist the phase to `run_state` for L7's quick startup view ("welcome back, you're in depth phase"), but the persisted value is a cache of the derived truth.

### Decision 2: Phase boundaries are constants, not config

**Why**: Three numbers (30%, 80%) are simple to reason about. Letting users tune them adds zero-percent of customer value at this stage and adds CLI surface to think about. The constants live in `src/phase.ts`; if we ever want to expose them, that's a one-line change.

### Decision 3: Checkpoint-based abort, not AbortSignal threading

**Why**: Wiring `AbortSignal` through every fetch in scrape/search/llm/embed is a lot of code touching a lot of files. Instead, the research loop checks `phaseMachine.now()` between every async step inside an iteration:

```
pop → search   ← checkpoint: if synthesis, exit
     → scrape  ← checkpoint
     → index   ← checkpoint per source
     → propose ← checkpoint
```

Wall-time accuracy: ~0–60s past the synthesis trigger before the loop actually exits, depending on which step was running. For a 5-hour run with a 1-hour synthesis window, that's noise. For a 90-second smoke test it's annoyingly close to the deadline but still functional.

L7 or a dedicated layer can revisit and add proper AbortSignal threading if we find ourselves losing work to long-running scrapes/LLM calls.

### Decision 4: `frontier.pop()` enforces synthesis lock at the data-access layer

**Why**: Defense in depth. Even if the loop's checkpoint logic has a bug, `pop()` refusing to return rows in synthesis phase makes "accidentally start a new search after deadline" structurally impossible. Two locks > one lock.

### Decision 5: Deadline parser rejects <60s

**Why**: A 30-second deadline produces a 9-second breadth phase, 15-second depth phase, 6-second synthesis phase. The agent literally cannot run a single iteration in that time (~7 min/iter). Better to refuse upfront than to silently fail the whole run. 60s is the smallest deadline that gives ANY chance of completing seed-decomposition before synthesis fires — useful for testing the phase machine itself.

### Decision 6: `--max-iters` becomes a safety cap, not the primary stopper

**Why**: With a deadline, iterations are no longer the unit of progress. Keep `--max-iters` available so a user with a "just don't go past N iterations" requirement can still set it. Default value: unlimited (set to `Number.POSITIVE_INFINITY` internally).

### Decision 7: Phase-aware scoring uses ENTIRELY different formulas, not just tweaked weights

**Why**: Breadth and depth are qualitatively different goals. Breadth wants to push wide, so novelty dominates. Depth wants to deepen promising threads, so the depth penalty inverts into a depth bonus. Scaling the same formula's coefficients wouldn't capture that — depth-as-bonus is a sign change, not a magnitude change.

Concretely:

```
Breadth:    0.4 * relevance + 0.5 * novelty + 0.1 * (0.7 ** depth)
Depth:      0.5 * relevance + 0.15 * novelty + 0.35 * min(1.5, 1.0 + 0.05*depth)
Synthesis:  0  (always)
```

Synthesis returning 0 makes any score-comparison between phases meaningless, which is fine — we don't compare across phases.

### Decision 8: One `phase.transition` event per real transition, not one per iteration check

**Why**: The loop checks the phase often. We don't want spam. The phase-machine module caches the last-observed phase in memory; only when the newly-derived phase differs does it emit. This makes `bun run watch --kind phase.transition` show exactly two events per typical run (breadth→depth, depth→synthesis), not thousands.

## Risks / Trade-offs

- **[Risk] Long single-step (e.g. a 30s LLM call) blows past synthesis trigger.** → Mitigation: checkpoint after every step. We accept up to one step's worth of overshoot. AbortSignal upgrade path documented.
- **[Risk] User passes `--deadline 5h` but their machine sleeps for 4h mid-run.** → On wake, `phaseMachine.now()` immediately reads `'synthesis'` (or `'done'` if past deadline). The next iteration checkpoint exits. We persist correctly.
- **[Risk] Phase-aware score change makes the test "smoke run" hit different patterns than L4's.** → Acceptable. The score formula is documented and tunable.
- **[Trade-off] Without AbortSignal threading, a misbehaving page that hangs scrape for 60s could overshoot synthesis trigger by that long.** → Scraper already has a 15s timeout. LLM calls are typically <30s. Worst-case overshoot ≈ 30s, acceptable for any deadline ≥ 15 minutes.
- **[Risk] CHECK constraint on `id=1` in `run_state` could cause inserts to fail under unexpected races.** → We use `INSERT OR REPLACE` (upsert), so concurrent runStart calls just clobber rather than fail. We're single-process anyway.

## Migration Plan

`bun run research "<task>" --max-iters N` continues to work — the phase machine just isn't engaged unless `--deadline` is also passed. (Or: when `--max-iters` is set without `--deadline`, we synthesize a deadline of "infinity" so the phase always reads `'breadth'` and the iteration cap stops it.) This keeps L4-style smoke tests working.

## Open Questions

- Do we want a `--phase-boundaries 30,80` flag for tuning? **Decided**: not yet. Add only when we see real-world need.
- What if `--deadline` is passed AND `--max-iters`? **Decided**: both apply, whichever fires first.
- Should `runEnd` always run, even on errors? **Decided**: yes, in a finally block in `runResearch`. The `phase=done` row is meaningful state.
- Do we resume a partial run on the next `bun run research` invocation? **Decided**: not in L5. L7 owns resume. For now, every `bun run research` call clobbers any prior run_state.
