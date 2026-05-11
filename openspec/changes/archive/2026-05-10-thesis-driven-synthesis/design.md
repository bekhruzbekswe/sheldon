# Design — thesis-driven-synthesis

## Context

Sheldon v1 (L0–L8) gathers facts then clusters them with k-means and writes one section per cluster. Stage 1 sharpened the gathering and writing within that flow (relevance gate, contract, source classifier, hedging prompt, Title-Case headings). Stage 1's smoke run made the structural ceiling visible: the contract correctly named the right angles in `good_answer_contains`, but the report drifted into recruiting tools and cloud-infra essays — because k-means buckets describe whatever clusters formed, not claims a smart analyst would defend in answer to the user's actual question. Reports A and B exhibited the same root cause in different costumes (a16z dominance / arxiv DRM tangents).

This change inverts the synthesis flow:

```
v1 (and S1):  facts → cluster → write per cluster → stitch
S2 (this):    facts → draft thesis → identify 4–7 claims → triangulate → write per claim → brutal-edit → stitch
```

`cluster-facts` stays in the codebase as a fallback for sparse-fact runs; the thesis path is the default for non-trivial corpora.

Constraints inherited from S1:

- `llm.fast` for everything (`llm.deep` still broken in production).
- New structured calls follow `response_format: json_schema` + retry-once + markdown-fence-strip.
- New event kinds extend the closed `EventKind` union.
- `T_DROP=-0.10` empirical tuning carried forward.
- The contract module owns task embedding + OOS embeddings; reused for sampling decisions here.

## Goals / Non-Goals

**Goals:**

- Make synthesis answer the user's actual question, not describe whatever the corpus drifted into. The report's structure comes from a drafted thesis, not from k-means topology.
- Each section *defends* a specific claim using ranked evidence; weak/unsupported claims are dropped, contested claims are explicitly flagged, thin-evidence claims are hedged.
- Triangulate the load-bearing claims with corroborate/contradict searches so the report can hedge or call contention, not just paraphrase the dominant cluster.
- Keep the cluster path alive as a safety net for sparse corpora; degrade gracefully rather than fail.
- Preserve all S1 wins (Title Case in fallback path, no transitional padding, hedging instructions, source classifications consumed by per-claim ranking).

**Non-Goals:**

- Changing how facts are *gathered* — proposer, scorer, frontier, decompose are untouched. Gathering quality is S3.
- Domain-diversity penalty in the scorer or proposer — S3.
- Gap analysis at phase boundaries — S3.
- Living-hypothesis revision across iterations — S4.
- Streaming responses or `llm.deep` re-enablement — orthogonal model-layer concerns.
- Cross-section consistency passes (deduplicating facts that show up in multiple sections, smoothing overlaps) — interesting, deferred.

## Decisions

### D1. Thesis-drafting runs at synthesis start, not interleaved with depth

**Choice:** the thesis-drafter is the first sub-step of the synthesis phase, not a depth-time pass. Synthesis order: `[draft thesis] → [triangulate per claim] → [retrieve facts per claim] → [write per claim] → [brutal-edit] → [stitch]`.

**Alternatives:**

- *Draft thesis early in depth, refine across iterations.* Rejected for S2: the corpus is incomplete during depth, so an early thesis is uncalibrated. Phase-boundary refinement is what S4 (living hypothesis) is for.
- *Draft thesis after each iteration (continuous re-thesis).* Rejected: cost grows linearly with iterations; the corpus during breadth/early-depth is too thin for a meaningful thesis.

**Rationale:** the L5 phase-machine already locks `frontier.pop()` at synthesis. The synthesis phase is the natural place to do work that depends on the whole corpus. ~5–10s at the start is acceptable.

### D2. Thesis input is a task-relevance-sorted, source-diverse slice (~40–80 facts)

**Choice:** the thesis-drafter receives a sampled fact slice, not the whole corpus. Selection:

```
1. Sort all facts by cosine(fact, taskEmbedding) DESC.
2. Greedy: walk the sorted list, accept a fact unless its domain already has 3 facts in the picked set.
3. Stop at N = 60 (configurable per-file constant SLICE_SIZE).
```

**Alternatives:**

- *Whole corpus.* Rejected: 200+ facts × ~50 tokens = 10K+ tokens of input, plus headers/instructions/output budget pushes against the 32K context. Sampling fits the call comfortably.
- *Random sample.* Rejected: random misses the most-relevant content.
- *Cluster centroids' best representatives.* Rejected: that's exactly what S1 did and what we're moving away from. Same failure mode under a new name.

**Rationale:** task-relevance ordering biases toward what the user actually asked; per-domain cap (3) prevents one source from monopolising the thesis the way a16z monopolised Report A's BPO section. The α/β tuning lives in this selection, not in the prompt.

### D3. Per-claim fact retrieval replaces `trimToCentroid`

**Choice:** for each thesis claim, score every fact by:

```
relevance_score(fact, claim) = cosine(fact, claim_embedding)
                             + 0.15 · source_weight(fact)
                             − 0.05 · domain_repeat_count(fact, picked_so_far)
```

`source_weight` from the `sources` table (S1): `academic`/`regulator` → +1.0, `analyst`/`trade-pub` → +0.6, `vc-blog`/`personal-blog` → +0.3, `vendor` → +0.1, etc. Roughly normalized to `[-0.5, +1.0]` then scaled by 0.15. `domain_repeat_count` is the number of facts already picked from this fact's domain — soft penalty against domain monopoly within a single section.

Take top-K = 10 facts per claim (per-file constant).

**Alternatives:**

- *Plain `cosine(fact, claim)` only.* Rejected: ignores the source-quality signal we worked for in S1.
- *Hard-cap one fact per domain per section.* Rejected: too restrictive — sometimes a single high-quality source is genuinely the best evidence for a claim.

**Rationale:** the original handoff's H6 framing ("section writer receives a claim, not a cluster"). Keeps S1's source labels load-bearing without yet introducing the full S3 scoring. The constants are starting points; tune from telemetry like `T_DROP`.

### D4. Triangulation runs at synthesis start, after thesis-drafting but before per-claim writing

**Choice:** for each thesis claim (4–7), run two targeted SearXNG queries — one corroboration variant (`<claim> evidence data report`), one contradiction variant (`<claim> dispute criticism limitation`). Top-3 results per query, scrape (with the existing scraper's per-source try/catch), extract claims, compute agreement signal. Update each thesis claim's metadata: `corroborations: number, contradictions: number, contested: boolean`. Section writer prompt consumes this.

Budget cap: a flat `TRIANGULATION_BUDGET_MS = 300_000` (5 min) across all claims combined. **Empirically retuned from `min(120s, 0.25 × remainingDeadlineMs)`**: first-run telemetry showed that synthesis runs AFTER the deadline expires (the L5 phase machine puts synthesis at the post-deadline 80%-100% slice without auto-killing), so `remainingDeadlineMs` was ~0 and only the first claim's triangulation completed before the budget killed the rest. A flat synthesis-phase wall-clock cap is the right shape because synthesis itself has no clock.

**Alternatives:**

- *Skip triangulation in S2; defer to a later stage.* Rejected: the proposal already promised it, and the value (hedging contested claims) is a real quality lift.
- *Triangulate during depth phase.* Rejected: we don't yet know what the load-bearing claims are. Drafting thesis first gives clean targets.
- *Use the existing fact corpus instead of new searches.* Rejected: the existing corpus is biased toward whatever the proposer found; targeted queries explicitly seek dissenting voices.

**Rationale:** moving triangulation from S3 (original plan) into S2 was already aligned in conversation: once the thesis has identified 4–7 claims, *those* are the load-bearing ones by definition. We don't need to guess.

### D5. Triangulation agreement is a heuristic, not exact

**Choice:** for each extracted claim from a triangulation result:

- If `cosine(extracted, claim_embedding) >= 0.55` and the surrounding 200-char window does NOT contain disagreement markers (`however`, `but`, `contrary`, `fails to`, `disputes`, `criticism`, `unlike`), count as corroboration.
- If `cosine(extracted, claim_embedding) >= 0.55` and the window DOES contain disagreement markers, count as contradiction.
- If `cosine < 0.55`, ignore (irrelevant to this claim).

A claim is `contested = true` when `contradictions >= 2` AND `contradictions / (corroborations + contradictions) >= 0.30`.

**Alternatives:**

- *Use an LLM to classify agreement per pair.* Rejected: too many calls (~28+ per run on top of the search budget).
- *Pure cosine, no negation detection.* Rejected: a contradiction often shares vocabulary with the claim it disputes — pure cosine collapses agree/disagree.

**Rationale:** keep it cheap. Misclassification is acceptable because the writer-side mitigation is "hedge" or "flag," not "drop." False contested-flags produce useful "some sources dispute" wording; false corroboration is dampened by the writer's existing thin-evidence rules.

### D6. Brutal-editor pass after drafting, before stitching

**Choice:** after all sections are drafted, run a `section-rubric` `llm.fast` call per section, returning:

```json
{
  "has_mechanism": true|false,    // does the section explain *how* X happens?
  "has_example": true|false,      // is there at least one concrete named example/case/number?
  "has_quantification": true|false, // any quantitative signal (%, $, n=N)?
  "defends_heading": true|false,  // does the body actually defend what the heading promises?
  "note": "string (one line, only on a fail)"
}
```

A section *fails* the rubric if (`has_mechanism === false` AND `has_example === false`) OR `defends_heading === false`. Failed sections get one revision attempt: re-call `writeSection` with the rubric note appended to the prompt as feedback. Still-failing sections are dropped (`section.dropped` event with reason).

Budget: ≤7 rubric calls + ≤7 revision calls = up to ~14 extra `llm.fast`. Wall-clock ~70–140s.

**Alternatives:**

- *Drop only on `defends_heading === false`.* Considered. Tighter than the chosen rule but might miss substance-poor sections that nominally defend their heading. Keep both checks.
- *Flag-only mode (don't drop, just annotate).* Available as a runtime fallback if early runs show the editor drops too aggressively. The orchestrator gets a `BRUTAL_EDIT_MODE` constant: `'drop' | 'flag'`. Default: `'drop'`.

**Rationale:** the deletion-lens framing (from §3 of the user's S1 follow-up) requires every stage to add explicit deletion points. S2's deletion points are: per-claim retrieval drops facts that don't earn a section, brutal-editor drops sections that don't earn their place, triangulation can downgrade a contested-and-mostly-contradicted claim before writing. Without the brutal-editor, S2 is structurally additive only.

### D7. Fallback to cluster mode when corpus is sparse or thesis fails

**Choice:** if `factStore.count() < 30` OR thesis-drafter returns fewer than 3 valid claims OR thesis-drafter throws, the synthesis orchestrator falls back to S1's cluster-driven flow (calling the existing `clusterFacts` and `writeSection(label, facts[])`). Emit `synthesis.fallback` with `payload: {reason, factCount, validClaims?}`. The S1 prompt rules are already in place in `sections.ts`, so fallback output should be S1-quality.

**Alternatives:**

- *Fail loudly.* Rejected: contradicts the project-wide non-throwing degradation pattern.
- *Try thesis with fewer claims (e.g., 2).* Rejected: a 2-claim thesis is structurally worse than a clean 3+-cluster cluster path. The fallback is the right answer.

**Rationale:** keeps S2 from regressing low-fact runs (a smoke test on a niche question with 18 facts shouldn't get worse than S1).

### D8. Heading source: `claim.headline` directly

**Choice:** thesis-drafter emits `claim.headline` as 3–8 plain-English words. The stitcher renders `## ${claim.headline}` directly — no slug → Title-Case transform on the thesis path. The cluster fallback path retains the S1 slug-rendering with the `INITIALISMS` set.

**Alternatives:**

- *Always slug + Title-Case.* Rejected: pointless when the headline is already English.
- *Generate headline post-write from the body.* Rejected: thesis-drafter already has the claim — re-deriving from the body adds an LLM call per section without benefit.

**Rationale:** the heading-content drift in Reports A/B happened because the heading was created before the section content existed. Now the heading IS the claim's headline, and the section body defends that exact claim, so heading-content alignment is structural.

### D9. Intro/outro consume thesis text + per-claim headlines, not kebab labels

**Choice:** `writeIntro(task, thesisSentences, claimHeadlines, runStats)` and `writeOutro(task, thesisSentences, claimHeadlines, claimMetadata, runStats)`. The intro prompt is rewritten: *"State the thesis directly (do not paraphrase the headline list). Reference the claims naturally."* The outro receives per-claim metadata (corroborations, contested) and is prompted to flag contested claims as open questions.

**Alternatives:**

- *Keep intro/outro unchanged (just labels).* Rejected: they were the documented cause of the "paraphrases the section list" failure mode in Reports A/B. Fixing the structure but leaving the framing layer untouched would produce a hybrid that says "this report explores X, Y, Z" while the rest of the report defends a thesis.

**Rationale:** the framing layer must reflect that there IS a thesis. Otherwise we leak the corpus-first mental model in the prose around the thesis-driven body.

### D10. Module organization

**Choice:** three new files, lightly coupled:

- `src/thesize.ts` — thesis-drafter. Exports `draftThesis(task, contract, allFacts) → ThesisOutput | null`. Pure: takes facts, returns thesis + claims (each claim already embedded).
- `src/triangulate.ts` — claim-triangulator. Exports `triangulateClaim(claim) → ClaimTriangulation`. Wraps SearXNG + scraper + extractor with a budget.
- `src/rubric.ts` — section-rubric. Exports `evaluateSection(section, claim) → SectionRubric`. Single `llm.fast`.

`src/synthesize.ts` becomes the orchestrator. It reads run state, decides thesis vs fallback, then drives the new pipeline. The brutal-editor pass lives inline in synthesize.ts (it's just a loop over rubric + maybe-revise + maybe-drop; no separate module needed).

`src/sections.ts` gains a new exported function `writeSectionFromClaim(claim, headline, rankedFacts, triMeta, ctx)` alongside the existing `writeSection(input, ctx)`. The legacy function is kept verbatim (cluster fallback uses it).

`src/cluster.ts` is unchanged. It's the fallback path.

**Rationale:** parallel new modules vs adding to existing ones — easier to reason about, easier to delete if S2 needs a redesign mid-flight, and matches the existing pattern (one capability ≈ one module).

## Risks / Trade-offs

- **Risk:** thesis-drafter hallucinates a claim the corpus can't support. → **Mitigation:** at per-claim retrieval time, if the top-K facts for a claim have `cosine(fact, claim) < 0.30` for ≥80% of the K, the claim is downgraded — written with explicit "evidence is thin" framing or dropped (depending on a per-file `MIN_CLAIM_SUPPORT` constant). Triangulation also surfaces this — a claim with 0 corroborations after triangulation is suspicious.
- **Risk:** D2's α/β/SLICE_SIZE/per-domain-cap constants are guesses. → **Mitigation:** all are per-file constants in `thesize.ts`. First real run logs which facts entered the slice (`thesis.drafted` payload includes a sample); we tune from telemetry the same way we tuned `T_DROP`.
- **Risk:** triangulation queries return more recruiting-tool / vendor marketing (the corpus drift from S1's smoke). → **Mitigation:** triangulation results pass through the S1 relevance gate at fact insertion, so off-topic noise gets dropped before scoring. Source-quality weighting in D3 further dampens vendor-source corroborations.
- **Risk:** brutal-editor drops legitimately-concise sections. → **Mitigation:** one-revision-before-drop, plus the `BRUTAL_EDIT_MODE='flag'` runtime fallback. If first runs show the drop rate is high (say >30%), switch to flag-only and tune the rubric.
- **Risk:** total synthesis budget exceeds ~5 min, eating into the deadline. → **Mitigation:** budget caps on each phase (D4 triangulation cap, D6 revision count). The phase-machine doesn't auto-extend; if synthesis runs long the run still ends with whatever was produced. Worst case we ship a report with 3 sections instead of 7.
- **Risk:** thesis-drafter and triangulation both hit the LLM/SearXNG with no caching; a cold first run pays full cost every time. → **Acceptable:** S2 is already cache-friendly via the S1 `sources` table; further caching is S3+ territory.
- **Risk:** cluster fallback is invoked but the S1 prompts produce different prose than the S2 prompts; report quality varies based on which path fires. → **Acceptable:** the fallback exists *because* it's better than no report. We tag the fallback path with `synthesis.fallback` so we know which runs took it.
- **Trade-off:** triangulation costs ~14–28 extra searches per run. For a run on an obscure topic where the open web has thin coverage, those queries will mostly return junk. → **Acceptable:** the budget cap is the safety; the writer falls back to "evidence is thin" hedging.

## Migration Plan

No DB schema changes. No new tables, no new columns. The `sources` table from S1 is consumed read-only.

Roll-forward: drop the new code in. The synthesis orchestrator changes default behaviour (thesis-first); old runs would silently still work because nothing they depend on changed.

Rollback: `git revert`. Cluster fallback path is `cluster-facts` (already in `openspec/specs/`), which the synthesize orchestrator can be reverted to call directly. No data corruption pathway.

## Open Questions

- **What's the right `SLICE_SIZE` for thesis input?** 60 is a starting guess. Smaller = thesis lacks breadth; larger = context bloat. Tune from `thesis.drafted` event payloads in early runs.
- **What's the right per-domain cap in D2?** 3 is a starting guess. May need to lower if the smoke run still shows one source dominating the thesis.
- **Should the thesis-drafter see the contract's `good_answer_contains` as part of its prompt?** Probably yes — it's a hint about what should be in the thesis. Easy to add; will include in implementation if proposal.md's intent agrees.
- **D5's contradiction-detection word list is hand-curated.** May need to be extended (e.g., "however") or replaced with a small classifier call after first run telemetry.
- **D6's rubric criteria `(has_mechanism && has_example) || defends_heading`:** is this the right composition? Could split into two failure modes: "shallow but on-topic" vs "off-topic." First runs will tell.
- **Can we keep triangulation results around as facts in the main `facts` table?** The corroborator/contradictor claims are real evidence. Storing them lets the report's `[N]` citations point at them properly. **Tentative yes** — triangulator inserts via the existing `factStore.insert` path so the relevance gate, dedupe, and source classifier all run as normal. The only addition is metadata linking these facts to their parent thesis claim. Document and finalize during specs phase.
- **Cluster fallback path: should the brutal-editor pass also run there?** The S1 prompt is already strict. Tentative: yes, run rubric on fallback sections too; same code, same drop semantics. Cheap insurance.
