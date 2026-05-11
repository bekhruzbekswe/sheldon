# Proposal — thesis-driven-synthesis

## Why

Stage 1's smoke run made the limit of cluster-driven synthesis explicit: the contract correctly named *"erosion of the low-cost labor value proposition"*, *"shift from FTE-based to outcome-based pricing"*, and *"AI startup competitors displacing legacy vendors"* as `good_answer_contains` items, but the report still drifted into recruiting-tool marketing and cloud-infra essays — because k-means on fact embeddings can only ever produce sections that describe whatever clusters formed, not sections that defend specific claims about the user's actual question. Reports A and B exhibited the same root cause in different costumes (a16z dominance / arxiv DRM tangents). This change inverts synthesis: at synthesis time, draft a 3–5 sentence thesis from a task-relevance-sorted, source-diverse fact slice; identify 4–7 numbered claims that structure the thesis; write one section *defending* each claim with claim-relevance-ranked evidence; triangulate load-bearing claims with corroborate/contradict searches so the writer can hedge or flag contested. A brutal-editor rubric drops sections that fail the mechanism/example/defends-heading test. Cluster-driven flow stays as a fallback for low-fact runs.

## What Changes

- **NEW** `thesis-drafter` capability: at synthesis time, after fact gathering completes, sample a task-relevance-sorted, source-diverse slice of facts (size ~40-80, max 3 facts per domain) and call `llm.fast` to produce `{thesis_sentences[3..5], claims[4..7]}`. Each claim has a one-sentence body, a 3–8 word headline (becomes the H2), and a rationale. Each claim is embedded for the per-claim retrieval that follows.
- **NEW** `claim-triangulator` capability: per thesis claim, run two targeted SearXNG queries (corroborate / contradict), scrape top-3 each, extract claims, score agreement/disagreement, store as claim metadata. Budget: ~14–28 searches per run total. Runs as the first sub-step of the synthesis phase, with its own checkpoint.
- **NEW** `section-rubric` capability: one `llm.fast` call per drafted section emits `{has_mechanism, has_example, has_quantification, defends_heading}` booleans plus a one-line note. Drives the brutal-editor pass.
- **MODIFIED** `section-writer`: input shape changes from `(label, facts[], originalTask)` to `(claim, headline, rankedFacts[], triangulationMetadata, originalTask)`. Prompt: *"defend this claim using these facts, ranked by relevance and source quality. Drop facts that don't actually support the claim. Hedge if triangulation count < 2. If contested, explicitly say so and cite both sides."* The S1 prompt rules (no transitional padding, banned closer-words, hedging, omit weak) carry forward.
- **MODIFIED** `report-stitcher`: section heading source changes from cluster label (kebab → Title Case) to `claim.headline` (already plain English). `writeIntro` and `writeOutro` receive `thesis_sentences` and the per-claim headlines, not just kebab labels — intros now state the thesis directly rather than paraphrasing the section list.
- **MODIFIED** `cluster-facts`: becomes a fallback path. The synthesis orchestrator tries thesis-drafter first; if the corpus is sparse (`<30` facts) or thesis-drafter returns `<3` valid claims, fall back to S1's cluster-driven flow with the S1-improved prompts. A `synthesis.fallback` event is emitted with the reason.
- **MODIFIED** `event-log`: `EventKind` extended with `thesis.drafted`, `claim.triangulated`, `section.rubric`, `section.dropped`, `synthesis.fallback`. `format.ts` gains matching cases.
- **NEW** brutal-editor pass: after all sections are drafted, run `section-rubric` on each. Failures get one revision attempt with the rubric note as feedback; still-failing sections are dropped (with `section.dropped` event).
- Per-claim fact retrieval (load-bearing for H6) replaces `trimToCentroid`. For claim `c`, score every fact `f` by `cosine(f, c) + α·source_weight(f) − β·domain_concentration(f, already_picked)` and take top-K (K=8–12). Source weight from S1's `source-classifier` table.

Not BREAKING: cluster-driven flow remains intact as fallback. Default behaviour changes for non-trivial corpora.

## Capabilities

### New Capabilities

- `thesis-drafter`: run-time module that, given the gathered fact corpus and the run's task + contract, drafts the report's thesis (3–5 sentences) and identifies 4–7 numbered claims with headlines and rationales. Outputs are JSON-schema'd, embedded, and consumed downstream.
- `claim-triangulator`: per-claim corroborate/contradict pass. Budget-bounded targeted SearXNG queries + scrapes + extraction; updates per-claim metadata (corroborations, contradictions, contested flag) used by the section writer.
- `section-rubric`: one `llm.fast` call per section emits a small structured rubric `{has_mechanism, has_example, has_quantification, defends_heading, note}`. Drives the brutal-editor pass and surfaces section-level confidence labels.
- `synthesis-orchestrator`: the dispatch layer that owns the synthesis phase's order of operations. Decides between the thesis path (default) and the cluster fallback path (sparse corpus or thesis failure), runs triangulation, drives the brutal-editor pass (revise once, then drop), and calls the stitcher last. Emits `synthesis.fallback` when the cluster path fires.

### Modified Capabilities

- `section-writer`: gains a new function `writeSectionFromClaim(claim, headline, rankedFacts, triMeta, ctx)` alongside the existing `writeSection(input, ctx)`. The legacy function is unchanged (cluster fallback still uses it). The new function's prompt instructs *defending* a specific claim, ranking facts, hedging when triangulation < 2, flagging contested claims. S1 rules (no transitional padding, banned closers, omit weak) carry forward.
- `report-stitcher`: heading source on the thesis path becomes `claim.headline` directly (no slug rendering — headlines are already plain English). Cluster fallback retains S1's Title-Case slug rendering. Intro/outro signatures extended to receive thesis text + per-claim metadata in addition to labels.
- `event-log`: `EventKind` extended with `thesis.drafted`, `claim.triangulated`, `section.rubric`, `section.dropped`, `synthesis.fallback`. `format.ts` gets matching cases.

## Impact

**Code**: new modules `src/thesize.ts` (thesis-drafter), `src/triangulate.ts` (claim-triangulator), `src/rubric.ts` (section-rubric). Touched: `src/synthesize.ts` (orchestration inverts; cluster path becomes fallback), `src/sections.ts` (input shape + prompt rewrite), `src/cluster.ts` (no behaviour change; still the fallback), `src/events.ts` + `src/format.ts` (new kinds + cases).

**Run-time cost**: thesis-drafter adds ~1 `llm.fast` call (~5–10s) at synthesis start. Triangulation adds ~12–28 targeted searches and ~28–56 scrapes (parallelizable). Section rubric adds ~5–7 `llm.fast` calls. Brutal-editor revision adds up to 7 extra section-writer calls in the worst case. Total synthesis budget rises from ~1–2 min to ~3–5 min. Acceptable against the 15-min+ deadlines we run; we may tighten or budget-cap triangulation if it eats too much depth phase.

**Dependencies**: S1 must be shipped (it is — archived as `2026-05-10-synthesis-quality-stage-1`). This change consumes the cached task embedding, the contract's `out_of_scope` (for source-diverse sampling), and the `sources` classifier table (for source-weighted ranking). No new external services; same `llm.fast` + JSON-schema + retry-once pattern.

**Risk**: thesis-drafter hallucinates a thesis the corpus can't support; mitigation = if any claim cannot find ≥3 supporting facts at retrieval time, downgrade or drop it (logged via `claim.triangulated` with a thin-evidence note). Per-claim retrieval may concentrate on the same domain if the corpus is domain-skewed; mitigation = the diversity penalty `β·domain_concentration` in the ranking term. Brutal-editor false positives on legitimately concise sections; mitigation = one-revision before drop, plus a soft "flag-only" mode the orchestrator can switch to if drop rate is high in early runs.

**Out of scope** (deferred to S3 per `docs/stages/`): gap analysis at phase boundaries, source-weighted scoring inside the frontier scorer (S3 H10), domain-diversity penalty *at the proposer* (S3), proposer fresh-bias fix, contract revision at phase boundaries.
