# Design — research-quality

## Context

S1 + S2 fixed *what the agent does with what it gathered* — relevance gate, contract, source classifier, thesis-driven synthesis, triangulation, brutal-editor pass. They produce sharp reports given the corpus. S2's smoke run made the corpus-side ceiling visible: most sections came back `has_example=false` from the rubric because the corpus *itself* lacked named-player evidence. The thesis-drafter and per-claim retrieval did everything they could; the gap is upstream in *what gets gathered*.

This change targets three structural gathering blind spots:

1. **Proposer fresh-bias.** `research.ts:170` reads `factStore.list({limit: RECENT_CLAIMS_FOR_PROPOSER})` ordered by `created_at DESC`. The proposer always sees the freshest 8 claims — whatever was *just* extracted. If a16z was scraped recently, the next batch of proposals will all be a16z-flavoured. Once a thread starts, it self-reinforces.
2. **No "what's missing?" pass.** The agent only follows threads from what it already found. There's no point in the run where someone asks "given the task and what we have, what should we still be looking for?". Pricing models, GCCs, named players never enter because they were never on a thread the proposer pulled.
3. **No diversity bias on follow-up generation.** `score.ts` has relevance, novelty, depth — no domain-saturation signal. A vendor blog and an arxiv paper score identically for the proposer's purposes.

S3 addresses all three. It does NOT modify the scorer (the diversity signal lives at the proposer where saturation is knowable; see Decision D5).

## Goals / Non-Goals

**Goals:**

- Inject "what important angles are missing?" as new seed questions at phase boundaries.
- Make the proposer's view of "recent claims" task-relevance-sampled with a per-domain cap, so it stops reinforcing whichever vendor was just scraped.
- Tell the proposer (via prompt) which domains are saturated, so it biases future questions toward different sources.
- Allow the contract's `out_of_scope` list to evolve based on what the run learns at each phase boundary.
- Lift the corpus-quality ceiling so S2's per-claim retrieval has named-player evidence to work with — closing the `has_example` gap surfaced in S2's smoke run.

**Non-Goals:**

- Modifying the scorer (`score.ts`). Frontier candidates don't have a source until they're scraped, so source-quality and domain-saturation at the scorer have no clean semantics. Both signals belong at the proposer (LLM-level prompt) and at S2's per-claim retrieval (already in place).
- Living-hypothesis revision across iterations (S4).
- Triangulation budget perf fix from S2's smoke (independent follow-up).
- Banned-closer-words deterministic post-processor (independent follow-up).
- Hand-curated source-quality lists (subjective and maintenance-heavy; S1's classifier-derived weights are good enough).
- Persisting saturated-domain telemetry across runs.
- Cross-iteration redundancy detection / early-synthesis trigger (interesting; deferred).

## Decisions

### D1. Gap analysis runs at phase boundaries inside the main loop, not at synthesis start

**Choice:** the gap-analyzer is invoked from `research.ts` immediately AFTER each phase transition's first `phaseMachine.now()` returns the new phase. Two trigger points: breadth → depth (~30% of deadline) and depth → synthesis (~80%).

**Alternatives:**

- *Run gap analysis every N iterations.* Rejected: over-costly for what gap analysis is supposed to do. Phase boundaries are the natural moments to step back and ask "what's missing?".
- *Run only at breadth → depth.* Considered. Could ship S3 with a single boundary and add the second later. Going with both because the depth → synthesis boundary is the LAST chance to inject seeds before search is locked.
- *Run as a synthesis-time pass (like S2's triangulation).* Rejected: by synthesis time, frontier is locked (`frontier.pop` returns null in synthesis phase). New seeds at synthesis time would just sit unprocessed.

**Rationale:** the L5 phase machine already emits `phase.transition` events. Hooking gap analysis to those transitions is a clean control-flow point. ~10s per boundary × 2 = ~20s budget cost; small relative to a 15-30 min run.

### D2. Gap-analyzer input is task-relevance-sorted, source-diverse — same selector as the thesis-drafter

**Choice:** the gap-analyzer's prompt receives ~30-50 sampled facts. Selection logic is identical in shape to the thesis-drafter's `selectSlice`: sort by `cosine(fact, taskEmbedding)` desc, greedy pick with per-domain cap. Per-file constants `GAP_SLICE_SIZE = 40`, `GAP_MAX_PER_DOMAIN = 3`.

**Alternatives:**

- *Reuse the thesis-drafter's `selectSlice` directly.* Rejected: the thesis-drafter's slice selector is private to `thesize.ts` and uses different constants. Extracting to a shared utility risks coupling. For S3, copy the small function — one is fine, two is fine, three would be a refactor signal.

**Rationale:** task-relevance ordering biases the gap-analyzer toward "what's missing relative to the question" rather than "what's missing relative to whatever was scraped". Per-domain cap stops one site from dominating the gap-analyzer's view of the corpus.

### D3. Gap-analyzer output integrates as standard frontier seeds with `topicTag: 'gap'`

**Choice:** each output question is pushed through the existing `frontier.push()` path with the proposer's `relevance` LLM-derived score as `relevance`, `novelty` recomputed against existing frontier embeddings, depth=0 (these are NEW seeds, not follow-ups; no parent_id), and the standard `score()` formula with the current phase. The `topicTag` field on the inserted frontier row is `'gap'` so we can distinguish gap-derived seeds from `decompose.ts`-derived seeds in event payloads.

Wait — the `frontier` table currently doesn't store `topicTag`. Looking at the schema: `frontier(id, question, score, status, parent_id, depth, embedding, created_at, processed_at)`. So `topicTag: 'gap'` would be a new column OR we use a different mechanism. Cheaper alternative: the `gap.analyzed` event's payload already records the gap-derived questions; the frontier doesn't need a new column. Tagging happens at the EVENT level, not the frontier level.

**Alternatives:**

- *Add a `topicTag` column to `frontier`.* Rejected: schema bump for telemetry only. The event payload is enough.
- *Push gap questions with high `relevance` to ensure they get popped.* Considered. The proposer's relevance scores are already in `[0, 1]`; gap-analyzer's outputs use the same scale and compete on equal footing in the frontier. No special-casing.

**Rationale:** zero new schema, zero new constraints; the event log carries the provenance.

### D4. Proposer fresh-bias fix: task-relevance-sampled slice with domain cap

**Choice:** in `src/research.ts:170`, replace:

```ts
const recentFacts = factStore.list({ limit: RECENT_CLAIMS_FOR_PROPOSER });
```

with:

```ts
const taskEmb = getTaskEmbedding(); // S1's research-contract module
const candidates = taskEmb
  ? factStore.findSimilar(taskEmb, { topK: RECENT_CLAIMS_FOR_PROPOSER * 2 })
  : factStore.list({ limit: RECENT_CLAIMS_FOR_PROPOSER });
const taskRelevantClaims = domainCap(candidates, RECENT_CLAIMS_FOR_PROPOSER, /*maxPerDomain=*/ 2);
```

`domainCap` is a small helper (in research.ts or extracted to a util) that walks the candidate list greedily, accepting facts unless their domain already appears `maxPerDomain` times in the picked set.

If `taskEmb` is null (e.g., contract drafting failed and the embedding cache is empty), fall back to the legacy recency-sorted slice. Defensive carve-out for partial-state runs.

**Alternatives:**

- *Pure random sample.* Rejected: random misses the task-relevant signal we want.
- *Top-K by task-cosine without domain cap.* Rejected: when the corpus is dominated by one domain (e.g., a16z early in a run), the task-relevance slice would also be dominated. The cap is the active-diversity step.
- *More aggressive cap (`maxPerDomain = 1`).* Considered. Too restrictive for early-run corpora with few domains. 2 is permissive while still breaking single-domain monopolies.

**Rationale:** this is the load-bearing fix for the proposer's self-reinforcing-thread failure mode. Trivially small code change (a few lines in research.ts), qualitatively different proposer behaviour.

### D5. No scorer change in S3

**Choice:** `score.ts` is untouched. The diversity signal lives at the proposer (LLM-level bias via `<saturated_domains>` hint) and at S2's per-claim retrieval (already weighting source-quality + domain-repeat).

**Alternatives:**

- *Add additive `domainSaturationPenalty` to score().* Rejected for S3: needs a way to map a frontier candidate (a question, not yet a fact) to a likely domain. Possible heuristic: use the parent question's facts' dominant domain. But this is speculative — frontier candidates can search the open web freely; their actual sources aren't predictable from the parent's domain.
- *Add multiplicative `sourceQuality` to score().* Rejected for the same reason: candidate questions have no source until scraped.

**Rationale:** scoring is for ranking what's already in the queue. Source/diversity signals belong at generation (proposer) and consumption (synthesis-time per-claim retrieval). The scorer's existing relevance + novelty + depth shape covers what it can know.

If first-run S3 telemetry shows that the proposer's LLM-level diversity bias is too soft (e.g., the corpus still tilts toward a single domain after S3), a deterministic scorer-level penalty using the parent question's dominant-domain heuristic could be a follow-up. Defer until evidence demands it.

### D6. Saturated-domains computation: cheap query, called per proposer invocation

**Choice:** `getSaturatedDomains()` (small helper, lives in research.ts or a util module) runs a single SQL query: `SELECT count(*), source_url FROM facts GROUP BY 1` (extracting domain in JS afterwards), then computes:

```
saturated = domains where (count_in_domain / total_facts) > 0.40
            OR  count_in_domain > 5
```

Cost: O(n) over the facts table, but only at proposer-invocation time (once per iteration, not per fact). For corpora <10K facts, sub-100ms.

**Alternatives:**

- *Maintain an incremental counter.* Rejected: premature optimization. The single SQL roll-up is cheap.
- *Persist saturated-domain history across runs.* Rejected: out of scope. Saturation is per-run.

**Rationale:** simplest possible implementation. If perf becomes a problem at scale, easy to swap for an incremental counter later.

### D7. Contract revision at phase boundaries — full-replacement of `out_of_scope`

**Choice:** at each phase boundary (alongside gap analysis), the contract module's new `reviseContract(facts, currentContract)` runs one `llm.fast` call:

```
INPUT: currentContract, sample of facts the relevance gate dropped, sample of repeated-but-irrelevant claims that snuck through.
TASK: should `out_of_scope` be updated? Return {"out_of_scope": ["...", ...]} (full replacement; can also remove items proven relevant).
```

The returned `out_of_scope` array replaces the existing one in `run_state.contract_json`. The contract module's in-process `oosEmbCache` is invalidated and re-embedded on the next `getOutOfScopeEmbeddings()` call. Past inserted facts are NOT retroactively re-gated (the gate runs only on new inserts).

**Alternatives:**

- *Append-only revision.* Rejected: we want the ability to *remove* OOS items that proved relevant after all (e.g., "history of BPO pre-AI" was OOS in S2's contract but legitimate analyst writing on the canonical question references it).
- *Revise the entire contract (not just `out_of_scope`).* Rejected: scope creep. `core_question` and `sub_questions` are designed to be stable; only `out_of_scope` evolves with what the run learns.

**Rationale:** matches the contract revision idea sketched in §3 of the user's S1 follow-up. Full-replacement keeps the schema simple; cache invalidation handles freshness.

### D8. Phase-boundary hook integration in `research.ts`

**Choice:** the existing `phaseMachine.now()` is called multiple times per iteration (its `lastSeenPhase` cache emits transition events lazily). Adding a hook means: after each `phase.transition` event fires, run gap analysis + contract revision *once* before the next iteration. Implementation: in `processIteration`, after the existing `currentPhase()` checks, compare `currentPhase` against a local `lastObservedPhase` flag; if changed, run the boundary hook.

```ts
let lastObservedPhase: Phase = 'breadth';
async function maybeRunBoundaryHook(now: Phase): Promise<void> {
  if (now === lastObservedPhase) return;
  if (now === 'depth' && lastObservedPhase === 'breadth') {
    await runGapAnalysis();
    await runContractRevision();
  } else if (now === 'synthesis' && lastObservedPhase === 'depth') {
    // Run iff we still have iteration budget — checked separately by phase.machine.
    await runGapAnalysis();
    await runContractRevision();
  }
  lastObservedPhase = now;
}
```

The hooks run BEFORE `frontier.pop()` is called for the next iteration so any new seeds are eligible immediately.

**Alternatives:**

- *Wrap `phaseMachine.now()` to invoke hooks on transition.* Rejected: phaseMachine is supposed to be a pure clock function; injecting work into it leaks concerns.
- *Run hooks once per phase via a one-shot semaphore.* Same as the lastObservedPhase flag; pick whichever reads cleaner in research.ts.

**Rationale:** keeps phase machine pure. Hooks are integrated at the orchestration layer where they belong.

## Risks / Trade-offs

- **Risk:** gap-analyzer hallucinates "missing" angles that already exist in the corpus or that are genuinely irrelevant. Frontier wastes iterations on dead seeds. → **Mitigation:** the prompt explicitly requires concrete search-engine-answerable questions and prohibits restating existing sub-questions. The relevance score from the gap analyzer enters the frontier on equal footing with proposer questions; if a gap question scores low against `score()`, it sits at the bottom of the queue. First-run telemetry tunes the prompt.
- **Risk:** contract revision drift — the LLM mutates `out_of_scope` aggressively across boundaries, accidentally excluding legitimate adjacent content. → **Mitigation:** the revision prompt explicitly instructs "remove items only if proven relevant by the gathered facts; otherwise keep". Track the `contract.revised` event payload to compare before/after lists; first-run telemetry will show whether the LLM is being too eager.
- **Risk:** proposer fresh-bias fix changes the proposer's input distribution, which may produce different (not necessarily better) proposals. → **Mitigation:** the new slice still contains task-relevant claims, just sampled differently. The `<task_relevant_claims>` block name change is the only prompt-visible difference; the LLM should adapt smoothly. First-run telemetry compares proposer output quality across the same task pre/post-S3.
- **Risk:** saturated-domains hint at the proposer is purely advisory — the LLM may ignore it. → **Mitigation:** acceptable for first run. If telemetry shows the LLM ignores it, the deterministic fallback is the scorer-level penalty (D5's deferred follow-up).
- **Risk:** hooks fire twice if `phaseMachine.now()` is called multiple times in close succession during a transition. → **Mitigation:** the `lastObservedPhase` flag is per-call-site (in research.ts); guarantees one fire per real transition.
- **Trade-off:** ~40s of additional run-budget cost (gap analysis + contract revision × 2 boundaries). For a 15-min run, that's ~4% overhead. Worth it for the angles surfaced.
- **Trade-off:** contract revision can in theory loop (boundary 1 adds X to OOS; boundary 2 removes X; etc.). In practice, two boundaries per run is a tight cap; degenerate looping is unlikely. Acceptable.

## Migration Plan

No DB schema changes. No new tables, no new columns. The `sources` table from S1 is consumed read-only.

Roll-forward: drop the new code in. The new modules are pure functional additions; the existing run loop continues to work without them (research.ts integrates them additively at phase boundaries).

Rollback: `git revert`. No state corruption pathway.

## Open Questions

- **What's the right `GAP_SLICE_SIZE`?** 40 is a guess. If the slice is too small the gap-analyzer can't see the corpus's actual coverage; too large and the prompt bloats. Tune from `gap.analyzed` event payload after first runs.
- **Should the gap-analyzer see the contract's `good_answer_contains` items it has NOT yet covered?** Probably yes — if `good_answer_contains` says "named-player responses" and the corpus has zero TCS/Infosys facts, the gap-analyzer should explicitly notice. This is a small prompt structuring question; finalise during specs phase.
- **Is `0.40` the right saturation threshold?** Conservative starting value. If first runs show domains crossing 40% rarely, lower it. If too many domains cross 40% routinely, raise it.
- **Should contract revision also revise `good_answer_contains`?** Tentative no — `good_answer_contains` is about what a satisfying answer should *include*; only the run's success criteria, not what's been learned, should change it. `out_of_scope` is the "what we've learned to exclude" field. Stick with revising only `out_of_scope` in S3.
- **What if `factStore.findSimilar` returns fewer than `RECENT_CLAIMS_FOR_PROPOSER` matches above the default `minSim=0.5`?** Fallback to the recency-sorted slice. Defensive but easy to forget; flag in tasks.
