# S2 — Thesis-driven synthesis, triangulation, brutal editor

> **Status: shipped 2026-05-10** (change `2026-05-10-thesis-driven-synthesis` in `openspec/changes/archive/`).
> The architectural inversion. Replaces cluster-driven section generation with thesis-driven section defence. Cluster code stays as a fallback for sparse-fact runs.
>
> Smoke run on the canonical question hit the substantive bar from `docs/stages/README.md`: real thesis up front, 5+ missing-angle hits (token economics, outcome-based pivot, vendor lock-in, telemetry pricing, model poisoning), no off-topic drift, no vendor monoculture, contested triangulation surfaced explicitly. See `What actually shipped` at the bottom for the three known issues and their dependency status.

## Why this stage exists

Even with S1's relevance gate and prompt rewrites, the *structural* problem persists: sections are written from k-means buckets, not from claims a smart person would want defended. Specific evidence:

- **Title/content mismatch.** Report B's `ai-agents-rag-automation` contains zero discussion of AI agents or RAG — it's entirely about the BOT model. The section was named from cluster topology before its content was written, then written from a fact bucket whose dominant topic happened to drift.
- **One-source paraphrase passes for analysis.** Report A's `legacy-bpo-disruption-targets` cites a16z's *Unbundling the BPO* 14+ times — it's a paraphrase of one VC blog post, not a synthesis. With cluster-driven synthesis, "the cluster of facts that came from a16z" naturally becomes its own section.
- **Equal weight to every cluster.** Both reports give a 200–500 word section to every cluster regardless of importance. There's no ranking, no "the top one is X because Y." Without a thesis, the writer has no basis for ranking.
- **No hedging, no contradictions surfaced.** Both reports speak with uniform confidence regardless of evidence quality. A section with one supporting source reads as confidently as one with eight independent sources. Without per-claim triangulation, the writer can't distinguish.
- **Intro and outro paraphrase the section list.** `synthesize.ts:236-238` passes only `labels` to `writeIntro/writeOutro`. They literally cannot reference a thesis because none exists.

## Goal

Restructure synthesis around a 3–5 sentence thesis the agent draws from gathered evidence, identifying 4–7 key claims that structure that thesis. Each section *defends* a specific claim with ranked evidence; the writer is allowed and encouraged to drop weak facts and hedge thin ones. A brutal-editor pass after writing drops sections that don't earn their place.

## Hypotheses included

- **H1 — Thesis-driven synthesis.** Replace `cluster → write per cluster` with `gather → draft thesis → identify claims → write per claim`. New module orchestrates this. `cluster.ts` becomes a fallback path for low-fact runs.
- **H6 — Section writer receives a claim, not a cluster.** Each writer call gets: the claim to defend, the top-K facts most relevant to *that claim*, instruction to rank, drop weak, hedge thin. Replaces today's "here are 12 facts in a cluster, write 200–500 words."
- **H11 — Triangulation pass on load-bearing claims.** *Moved here from S3.* Once the thesis identifies 4–7 claims, *those* are the load-bearing ones by definition. For each: targeted search for corroboration ("does any other source support X?") and contradiction ("does any source dispute X?"). Each claim gains metadata: independent-corroboration count, contradictions, contested status. Section writer uses it to confidently state, hedge, or explicitly flag contested.
- **Brutal-editor pass** *(no H#, added per the deletion lens)*. After all sections are drafted: an `llm.fast` call evaluates each section against a small rubric — does it have a specific mechanism, named example, or quantitative claim? Does the body actually defend the heading? If a section fails the rubric, one revision attempt; if still failing, drop it.
- **Section-validation rubric** *(no H#)*. Same rubric used inline by the brutal editor. Per-section, one `llm.fast` call — small JSON answer — used both to drive the editor and to label the section's confidence in metadata.

## Capabilities

### New

- `thesis-drafter` — module that, given the corpus and the original task, drafts a 3–5 sentence answer plus a list of 4–7 numbered claims that structure the answer. Each claim gets its own embedding (used by H6 and H11). Replaces the structural role of `cluster-facts` for runs where the corpus is non-trivial.
- `claim-triangulator` — module that, per thesis claim, runs targeted corroborate/contradict searches and stores results as claim metadata. Operates in an extension of the depth phase or at the top of synthesis. Budgeted: one search + ≤2 scrapes per claim.
- `section-rubric` — small evaluator (one `llm.fast` per section) emitting `{has_mechanism, has_example, has_quantification, defends_heading}` booleans plus a one-line note. Drives the brutal-editor pass.

### Modified

- `section-writer` — input shape changes from `(cluster, facts)` to `(claim, ranked-facts, triangulation-metadata)`. Prompt: "defend this claim using these facts, ranked by relevance and source quality. Drop facts that don't actually support it. Hedge if triangulation count < 2. If contested, explicitly say so and cite both sides."
- `report-stitcher` — heading source changes from cluster label to *the section's claim, condensed* (LLM call to produce a 3–8 word headline from the claim, post-write). Removes the heading-then-content drift. Intro/outro receive the *thesis text* and *the actual claim list with their headlines*, not just slug labels.
- `cluster-facts` — kept, but only invoked as fallback when the corpus is too sparse for thesis drafting (configurable threshold, e.g. <30 facts) or when thesis-drafting fails. Emits `synthesis.fallback` event so we notice.
- `event-log` — extends `EventKind` with at minimum `thesis.drafted`, `claim.triangulated`, `section.rubric`, `section.dropped`, `synthesis.fallback`.

## Dependencies

- **S1 must ship first.** S2 reuses the task embedding and out-of-scope items from the contract for fact-relevance ranking when picking facts per claim. Source classification (H9) feeds the writer's source-quality awareness for hedging.

## Key data structures / decisions

**Thesis-drafter input:**

The full fact corpus is too large for one prompt. Sample a *task-relevance-sorted, source-diverse* slice: top-N facts by `cosine(fact, task)`, with a domain cap (e.g., max 3 facts per domain) to avoid one-source-dominates-thesis. Probably 40–80 facts per call.

**Thesis-drafter output (JSON-schema'd):**

```json
{
  "thesis_sentences": ["...", "...", "..."],   // 3-5
  "claims": [
    {
      "claim": "string (one sentence)",
      "headline": "string (3-8 words, plain English, will become the H2)",
      "rationale": "why this claim earns a section"
    }
    // ... 4-7 total
  ]
}
```

Each `claim` is then embedded and used as the retrieval anchor for H6.

**Per-claim fact retrieval (replaces `trimToCentroid`):** for claim `c`, score every fact `f` by `cosine(f, c) + α · source_weight(f) − β · domain_concentration(f, already_picked)`. Take top-K (probably 8–12). The trimming becomes claim-relative, not cluster-centroid-relative — this is the load-bearing fix the original handoff called out.

**Triangulation per claim:** for each of 4–7 claims, run two targeted SearXNG queries — one with the claim and a corroboration phrase ("evidence" / "data" / "report"), one with a contradiction phrase ("dispute" / "criticism" / "limitation"). Top-3 results each. Scrape, embed, check whether any extracted claim agrees or disagrees by `cosine + sign-of-supporting-language` (heuristic). Store on claim metadata. Budget: ~14–28 searches + ~28–56 scrapes total — meaningful, but parallelizable and well under the deadline budget.

**Brutal-editor pass:** after all section drafts, one `llm.fast` call per section runs the section-rubric. Failures get one revision attempt with the rubric's note as feedback. Still-failing sections are dropped; emit `section.dropped` with the rubric's reason. The user-facing report will then have fewer sections than claims — that's correct behaviour, not failure.

**Stitcher changes:**
- Headlines come from thesis-drafter output (`claim.headline`), not from cluster labels.
- Intro receives `thesis_sentences` joined as prose plus the claim headline list. Prompt: state the thesis directly, do not paraphrase the section list.
- Outro receives the same plus per-claim triangulation status. Prompt: synthesize what the report concluded; flag remaining open questions explicitly.

**Fallback path:** if the corpus has <30 facts or thesis-drafter returns <3 valid claims, fall back to S1's cluster-driven flow with the S1-improved prompts. Emit `synthesis.fallback` and an event payload describing why.

## Deletion lens

- **Per-claim fact retrieval** drops facts that don't support a specific claim — *every fact that didn't make any claim's top-K is implicitly dropped from the report*. This is the biggest deletion lift in the project.
- **Brutal-editor pass + rubric** drops sections that fail the mechanism/example/defends-heading check.
- **Triangulation contradictions** can downgrade a claim to "contested" or, if explicit-contradictions exceed corroborations and there's no clear nuance, drop the claim entirely (with logging). Threshold-tuned.
- **The fallback path** itself is a deletion of the new architecture for this run — opting out is sometimes the right move.

S2 is the stage where the deletion lens becomes structural.

## Out of scope (deferred to later stages)

- **Gap analysis at phase boundaries** (H4) — S3.
- **Source-weighted scoring + diversity penalty** (H10) — S3 (S2 uses source weights *passively* during fact ranking, but the proposer doesn't yet penalize over-represented domains for future searches).
- **Proposer fresh-bias fix** — S3.
- **Working hypothesis across iterations** (H3) — S4.
- **Contract revision at phase boundaries** — could ride along here or in S3; defer.
- **Cross-section contradiction detection beyond what triangulation surfaces** — S4 territory.

## Open questions

- **What's the right N for thesis-drafter input facts?** Too small and the thesis is shallow; too large and the LLM context burns. Start at 60, tune by inspecting the drafted thesis quality.
- **Should triangulation run during depth phase or at synthesis start?** During depth: any subsequent iteration sees the new evidence in the corpus. At synthesis start: the deadline is already eating budget. Tentative: run it as the first sub-step of synthesis phase, with its own checkpoint. Re-evaluate after a real run.
- **How do we handle a thesis that the gathered evidence doesn't actually support?** Thesis-drafter should refuse rather than confabulate; if it returns a thesis sentence with no claim able to find ≥3 supporting facts, downgrade or drop that thesis sentence. Hard problem; expect it to need a revision pass after first run.
- **Headline-from-claim vs claim itself?** The claim is the load-bearing unit; the headline is its short form. We could just use the claim sentence as the H2 and skip generating a headline — simpler, but produces long headings. Tentative: short headline, with the full claim showing as the section's opening sentence (matching the H8 thesis-sentence instruction from S1).
- **Brutal-editor false-positives?** A rubric could reject a legitimately concise section. The "one revision attempt before drop" is the safety valve; if it still drops good sections, soften the rubric or move it to a flag-only mode.

## Suggested openspec change name

`thesis-driven-synthesis`

---

## What actually shipped

The S2 thesis path produced a qualitatively different report than S1 / Reports A / B on the canonical question — a real thesis up front, headlines that ARE the claims (not slug labels), per-claim evidence ranking with source-quality weighting, brutal-editor revisions. Three issues remain open, each classified by whether it's structurally dependent on S3:

### Issue 1 — Triangulation budget perf (independent, follow-up)

**Symptom**: in both smoke runs, the first thesis claim consumed the entire 5-min flat triangulation budget on its own (sequential ingestion of 6 URLs × scrape + per-chunk LLM extract = 3-5 min per claim). Claims 2-N hit `error: 'budget exceeded'` with `queries=0` and received default metadata.

**Mitigation that's already in place**: defaulted metadata + the writer's `corroborations < 2` hedging path means those sections still ship with appropriate hedging, not silent confidence.

**Real fix**: switch from a flat-total budget to a **per-claim budget** AND **parallelize URL ingestion within a claim**. With per-claim budget = ~60s and 6 URLs in parallel, all 6 claims would complete triangulation in well under a 5-min total wall-clock.

**Dependency**: independent of S3. Touches `src/triangulate.ts` + `src/synthesize.ts` only. Worth a small standalone follow-up change rather than waiting for S3.

### Issue 2 — Banned-closer-words enforcement (independent, follow-up)

**Symptom**: the section-writer prompt forbids `Furthermore` / `Consequently` / `Ultimately` as the first word of any closing paragraph, but the model treats this as a soft preference. 2 of 5 sections in the S2 run ended with one of these words.

**Real fix**: deterministic post-processor — after `writeSectionFromClaim` returns a body, regex-check the first word of the last paragraph; if it's one of the banned set, send the LLM one corrective revision pass with the offending sentence excised. Or simpler: regex-rewrite the first word to one of `As such,` / `In sum,` / `That is,` and accept the cost.

**Dependency**: independent of S3. Pure synthesis-prose fix.

### Issue 3 — Examples gap (DEPENDENT on S3)

**Symptom**: the section rubric's `has_example` flag came back `false` for most sections in both S2 smoke runs, because the corpus lacked named companies and concrete cases (TCS, Infosys, Accenture, Cognizant, Wipro, Genpact — all absent). Without those facts in the corpus, the per-claim retrieval can't surface them and the section bodies stay abstract.

**Why this is S3, not S2**: this is a **gathering** problem, not a synthesis problem. S3's three pieces all attack it directly:
- Gap analysis at phase boundaries (H4) injects "what's missing? named players in this industry?" as new seed questions.
- Proposer fresh-bias fix replaces "freshest 8 facts" with "task-relevance-sampled 8 facts" so the proposer doesn't loop on whatever was just scraped.
- Domain-diversity penalty at the proposer biases future searches away from saturated vendor domains, opening room for analyst reports / news coverage that names players.

After S3 ships, S2's per-claim retrieval will have the right evidence to pull from and `has_example` will rise without any S2 code change.

### What this means for next steps

Order of work:
1. **S3 first** — addresses Issue 3 structurally and lifts the report quality across every future run, not just the canonical question.
2. **Re-evaluate Issues 1 + 2** after S3 ships. They may matter less once corpus quality jumps; if they still matter, open a small standalone follow-up change for both together (per-claim triangulation budget + parallel ingest + banned-closer post-processor).
3. **S4 stays deferred** — re-evaluate after S3 if reports still feel like gather-then-summarize rather than analyst-grade.
