## Context

Through L3, Sheldon answers a single question and indexes the resulting facts. To become a research agent it needs to ask itself follow-up questions and prioritize among them. L4 introduces the frontier queue, the decomposer that seeds it, the proposer that grows it, and the loop that runs it — all without a wall-clock deadline (that's L5).

The mental model: "Sheldon now has a to-do list for itself." Every iteration: pop the highest-scored item, do the L2/L3 work, ask the LLM what's worth investigating next given what was just learned, score those proposals, push back. The store grows; the queue evolves.

## Goals / Non-Goals

**Goals**

- Persistent SQLite-backed priority queue surviving across runs
- Novelty-aware push so the agent doesn't re-explore the same thread
- Depth-aware scoring so a single thread can't go arbitrarily deep at the cost of breadth
- Run loop with a hard iteration cap (no clock yet)
- Every iteration fully traced in the event log
- Observable via `bun run inspect --frontier` (if we add that flag) and `bun run watch --kind frontier.*`

**Non-goals**

- Wall-clock deadline / phase machine (L5)
- Phase-aware behavior shifts (L5)
- Parallelism — strictly sequential pop→work→push for now (avoiding writer contention)
- Synthesis / report writing (L6)
- Resume / crash recovery (L7)
- Re-trying skipped questions with rephrasings — too clever for L4

## Decisions

### Decision 1: Frontier lives in the same SQLite file as facts

**Why**: Keeps "the agent's state" in one transactional store. Resume in L7 just reopens this one file. Joins between facts and frontier (e.g. "all facts spawned by question 42") are SQL trivia. Adding a separate file would complicate persistence for nothing.

### Decision 2: Pop is a single transaction, status='in-progress' marker

**Why**: We're sequential by design, but using a transaction makes the code resilient to future parallelism and clearly distinguishes "popped but not yet completed" rows. L7 will use `in-progress` rows as a recovery signal: anything `in-progress` at startup was being worked on when the process died, and should be reset to `pending` on resume.

### Decision 3: Novelty dedupe at cosine ≥ 0.85, applied at push time

**Why**: Same idea as L3's fact dedupe (0.95) but more aggressive — questions are usually worded loosely, and "How does the EU AI Act regulate AI?" vs "What does the EU AI Act do?" are practically identical investigations. 0.85 caught these cleanly in informal testing. L3 facts use 0.95 because numerical claims with slightly different phrasings are genuinely distinct.

### Decision 4: Score formula is a fixed linear combination, not learned

**Why**: At our scale, hand-tuning three coefficients beats any learned approach. The current formula:

```
score = 0.5 * relevance + 0.3 * novelty + 0.2 * (0.9 ** depth)
```

- relevance dominates because the LLM's prior on what matters for the original task is the strongest signal
- novelty matters but is secondary — sometimes you want to deepen a known thread
- depth decay is subtle (0.9^d) so threads can go 10+ deep before completely losing priority

Coefficients are tunable via constants. Watch the L1 log to see if certain runs spin too narrowly (raise novelty weight) or fragment too wide (lower it).

### Decision 5: Decomposer asks for 12 seed questions

**Why**: Empirically a sweet spot — fewer means the agent runs out of breadth quickly; more means many seeds will be near-duplicates the dedupe will reject. 12 gives ample raw material for the dedupe to work on.

### Decision 6: Proposer sees only top-5 pending titles, not the whole frontier

**Why**: A 30-question frontier in the prompt would eat 1-2k tokens just for context. Top-5 captures "what's about to be worked on" which is what the proposer needs for novelty awareness. Trade-off: a thread that overlaps with a question buried at position 25 might get duplicated into the queue. The novelty filter at push time will catch it; this is just optimization.

### Decision 7: Sequential, not parallel iterations

**Why**: Two iterations running in parallel would race the SQLite writer, and (more importantly) cross-contaminate each other's "what claims did we just learn" context. Sequential is also easier to debug. L8 might add 2-way parallelism after L7 stabilizes resume.

### Decision 8: Iteration cap, not deadline (defer L5)

**Why**: We want to validate the loop's behavior before adding the time-pressure logic. With a fixed cap (default 10 for the smoke test), we can run a `bun run research "small task" --max-iters 5` end-to-end and see the queue evolve in 10–20 minutes.

## Risks / Trade-offs

- **[Risk] LLM proposes nonsense follow-ups when the parent question dead-ended (zero claims).** → Mitigated by the proposer prompt explicitly checking for "if no useful claims, return zero proposals." If we still see noise, we add an heuristic: skip proposing when `claimsExtracted === 0`.
- **[Risk] Frontier explodes to thousands of pending entries.** → Each push has the novelty dedupe. In practice we expect a fan-out of 3-5 per iteration with ~50% dedupe rate, so growth is sub-linear in iterations.
- **[Risk] Agent gets stuck on a vibrant thread, ignoring the original task.** → Depth decay forces newer-thread, breadth-first behavior over time. If we still see drift in real runs, we add a "score boost for siblings of the seed-question with parent_id 0" heuristic.
- **[Trade-off] Embedding every proposal before the dedupe check costs ~5–10ms per proposal.** → Tiny. Dedupe at insert time is the right call.
- **[Risk] All proposals from one iteration get deduped → the queue empties prematurely.** → If this happens, the loop just exits. Acceptable — it's a sign the agent has exhausted its leads on this corner.

## Migration Plan

Additive. `bun run ask` continues to work for one-shot Q&A. `bun run research` is the new multi-iteration entrypoint. Schema gains a new table; existing `facts` table is untouched.

## Open Questions

- Should we re-pop `skipped` questions later under any condition? **Decided**: No in L4. If a question dead-ends, that's information; mark it skipped and move on. Could revisit in L7 if the loop frequently exhausts pending too soon.
- Should the proposer sometimes propose siblings of *grandparent* questions to widen scope? **Pending**: Watch first runs. If threads narrow too aggressively, add a "broaden" prompt variant.
- How do we present the running frontier to the user? **Pending**: For L4 we just dump it via `inspect --frontier`. L8 dashboard will visualize.
- Are 0.5/0.3/0.2 the right scoring coefficients? **Pending**: Tune from observed runs.
