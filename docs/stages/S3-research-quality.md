# S3 — Gap analysis, source-weighted scoring, proposer fix

> **Status: shipped 2026-05-10** (change `2026-05-10-research-quality` in `openspec/changes/archive/`).
> S3's machinery — boundary hook + gap analyzer + contract revision + proposer fresh-bias — all fire correctly per smoke-run telemetry. Source diversity in the resulting report is materially better than S2 (12 distinct domains, no source cited more than 4 times). The named-players gap that motivated S3 is **not** fully closed in this run; see "What actually shipped" at the bottom.
> One scope reduction relative to the original stage doc: the scorer (`score.ts`) was intentionally NOT modified (design decision D5). Frontier candidates have no source until they're scraped, so source-quality at the scorer has no clean semantics. Diversity bias lives at the proposer (LLM-level) and at S2's per-claim retrieval (already in place).

## Why this stage exists

S1 stops drift; S2 restructures synthesis. Both improve quality given the corpus. But the corpus itself is shaped by what the agent searches for, and the agent's search behaviour has structural blind spots:

- **Both reports missed angles a human analyst would surface in 4 hours.** Pricing-model collapse (FTE/seat → outcome-based), wage-arbitrage erosion as AI handles work cheaper than offshore labour, cannibalization (selling AI productivity ⇒ selling clients fewer seats), GCC/captive-centre competition eating BPO share, named players' actual responses (TCS, Infosys, Accenture, Cognizant, Wipro, Genpact). None appear in either report. This isn't a synthesis problem — these angles never entered the corpus.
- **The proposer is blind to its own bias.** `propose.ts:67-83` and `research.ts:170` show the proposer sees `factStore.list({limit: 8})` ordered by `created_at DESC` — i.e., whatever was *just* extracted. If a16z was scraped recently, the next batch of proposals will all be a16z-flavoured. Once a thread starts, it self-reinforces.
- **No source-quality signal anywhere in scoring.** `score.ts` has only relevance, novelty, depth. A vendor-marketing scrape and an arxiv paper score identically. With no penalty for domain over-representation, a single source can dominate the corpus (a16z cited 14+ times in Report A's BPO section).
- **No "what's missing?" pass.** The agent only follows threads from what it already found. There's no point in the run where someone asks "given the task and what we have, what should we still be looking for?"

## Goal

Make gathering goal-directed rather than corpus-directed. Add an explicit gap-analysis pass at phase boundaries; teach the scorer that source quality and diversity matter; fix the proposer's fresh-bias.

## Hypotheses included

- **H4 — Gap analysis at phase boundaries.** At breadth → depth (and optionally depth → synthesis), one `llm.fast` call: "given the original task, the contract's `good_answer_contains`, and a sampled cross-section of facts, what important angles are missing?" Returns 3–5 new seed questions, pushed onto the frontier with high relevance.
- **H10 — Source-weighted scoring + domain-diversity penalty.** Two pieces:
  1. Each fact carries its source's quality tier (from S1's `source-classifier`). Per-claim ranking in S2 already uses this passively; here it also enters `score.ts` so high-quality-domain proposals score higher.
  2. **Domain-diversity penalty applied at the proposer**, not at fact insertion (per the original handoff's tradeoff #4 — bias future searches away from saturated domains, don't drop existing evidence). When ≥40% of recent facts come from one domain, future proposals from / about that domain are penalized.
- **Proposer fresh-bias fix** *(no H#, surfaced during S1 code review)*. Replace `factStore.list({limit:8}, ORDER BY created_at DESC)` in the proposer's input with a *task-relevance-sampled* slice — top-K facts by `cosine(fact, task_emb)` (uses the cached embedding from S1), with a domain cap to enforce diversity. Tiny change, materially shifts what the proposer sees.
- **Contract revision at phase boundaries** *(originally noted as out-of-scope for S1)*. At each phase boundary, one `llm.fast` call: "given what we've learned, should `out_of_scope` be updated?" Catches cases like "during breadth, generic AI privacy content kept showing up; flag it as OOS for the rest of the run." Cheap addition, fits naturally with H4.

## Capabilities

### New

- `gap-analyzer` — module that runs at phase boundaries. Inputs: original task, contract, sampled facts. Output: 3–5 new seed questions tagged with `source: gap-analysis`. Pushed onto the frontier with the existing scoring path.
- `domain-frequency-tracker` — small helper (or column on `facts` joined with `sources`) that lets the scorer / proposer cheaply ask "what fraction of current facts come from domain X?". Probably no new table — a query against `facts.source_url` parsed to domain, joined with `sources`, will do.

### Modified

- `scorer` — `score.ts` gains a quality term and a domain-saturation term. Pure functions; signature extends with optional `sourceQuality` and `domainSaturation` parameters with sensible defaults so old call sites don't need to know.
- `followup-proposer` — `propose.ts` consumes a task-relevance-sampled fact slice instead of `created_at DESC`. Also receives a small "saturated domains" hint and is prompted to bias against them.
- `research-contract` (from S1) — gains `reviseContract(facts, contract)` for phase-boundary updates. Persists the new contract back to `run_state.contract_json`. Out-of-scope embeddings re-cached.
- `event-log` — extends `EventKind` with `gap.analyzed`, `contract.revised`, plus a `score.weight_breakdown` payload field on the existing `frontier.push` event so we can see which terms drove a score (without a new event kind).

## Dependencies

- **S1 must ship.** Gap analyzer needs the contract; quality scoring needs the source-classifier; proposer fix needs the cached task embedding.
- **S2 strongly preferred.** S2's per-claim source-quality awareness shares infrastructure with S3's scoring. Doable independently if S2 slips, but the best outcome comes from S2 + S3 together.

## Key data structures / decisions

**Gap-analyzer prompt:**

```
INPUT
- The original task (from run_state).
- The contract's `core_question`, `sub_questions`, `good_answer_contains`, `out_of_scope`.
- A sampled cross-section of N facts (probably 30-50, picked for source diversity and task-relevance, NOT recency).

TASK
What 3-5 angles relevant to the task are *not yet covered* by the gathered facts?
Each angle is a concrete question that could be searched and produce useful facts.
Avoid restating sub-questions already in the contract.
Avoid generic meta ("more case studies"); be substantive ("how is TCS's outcome-based pricing structured for AI work?").
Output JSON: {"gaps": [{"question": "...", "why": "...", "relevance": 0.X}, ...]}.
```

The new questions are pushed to the frontier with `relevance` from the LLM and the standard score formula. Tagged in their `metadata` so we can attribute outcomes later.

**Phase boundary timing:**

- breadth → depth (~30% of deadline): definitely run gap analysis. This is when course-correction has the most leverage.
- depth → synthesis (~80%): consider running, but lower-priority — synthesis is locked, so any new questions go straight to the queue and may not get processed. If the depth phase still has ≥10% headroom, run it; else skip.

**Source quality tiers** (using S1's `sources.source_type` and `promotional_intent`):

```
weight = base weight by source_type
       × (1 - 0.4 * promotional_intent_score)
       × (1.0 if primary, 0.85 if mixed, 0.7 if derivative)

Default weights by type (starting point, tune empirically):
  academic         : 1.0
  regulator        : 1.0
  analyst          : 0.9
  trade-pub        : 0.75
  vc-blog          : 0.7
  vendor           : 0.5
  personal-blog    : 0.5
  forum            : 0.3
  other            : 0.6
```

The weight enters `score.ts` as a multiplicative factor on the relevance term. Out-of-band: the same weight feeds S2's per-claim fact ranking (passing through the fact-store's join with `sources`).

**Domain-saturation penalty in the proposer:**

```
saturated = domains where (facts_from_domain / total_facts) > 0.40
            OR  facts_from_domain > 5
```

The proposer's prompt gets a list of saturated domains and an instruction: "the corpus is over-represented by these sources; propose questions that would draw from different sources." The score formula additionally subtracts 0.15 from candidates whose probable domain (heuristic from question content) overlaps with a saturated one — this is fuzzy but cheap.

**Contract revision:** at each phase boundary, before gap analysis, one `llm.fast` call:

```
INPUT: current contract, list of dropped-as-irrelevant claims (sample), list of any topics that came up repeatedly without being on-topic.
TASK: should `out_of_scope` be updated? Return {"new_out_of_scope": ["...", ...]} (a full replacement; can also remove items if learning showed they're actually relevant).
```

Re-embed the new `out_of_scope`. The fact-store gate now uses the updated set on subsequent inserts. Past insertions are NOT retroactively dropped — they're already in the corpus and the deletion-lens for them happens at S2 synthesis time.

**Proposer fresh-bias fix, exact change:**

`research.ts:170` currently does:
```ts
const recentFacts = factStore.list({ limit: RECENT_CLAIMS_FOR_PROPOSER });
```

Change to:
```ts
const recentFacts = factStore.findSimilar(taskEmbedding, {
  topK: RECENT_CLAIMS_FOR_PROPOSER * 2,
}).slice() // then domain-cap to RECENT_CLAIMS_FOR_PROPOSER, max 2 per domain
```

Replaces "freshest" with "most task-relevant, source-diverse." Trivial code change, qualitatively different proposer behaviour.

## Deletion lens

- **Contract revision** can *drop* topics from the corpus that were collected before they were marked out-of-scope. The mechanism: at synthesis time (S2), the per-claim retrieval already favours task-relevant facts, so newly-OOS facts will naturally lose. Optional: add an explicit "purge facts whose `cosine(fact, task) - max_oos < T_drop` after revision" step. Keep optional — purging is destructive, log-and-keep is safer.
- **Domain-saturation penalty** doesn't drop anything, but biases future gathering toward dropping the *opportunity cost* of staying in the saturated domain. Soft deletion of one trajectory.
- **Gap analyzer** is purely additive — it pulls in new content. By itself this stage is mostly *gathering* improvement, not deletion improvement. The deletion contribution comes from contract revision + purge.

## Out of scope (deferred to later stages)

- **Working hypothesis maintained across iterations** (H3) — S4.
- **Cross-iteration contradiction tracking beyond what S2's triangulation surfaces** — S4 territory.
- **Redundancy / fact-velocity-based early-synthesis trigger** — interesting, defer. The current `--deadline` flow assumes the deadline is the budget; switching to "budget-or-redundant" is a phase-machine change with downstream ripples.
- **Hand-curated source-quality lists** — explicitly avoided. Subjective, maintenance-heavy. The classifier-derived weights are good enough for v2.

## Open questions

- **Does gap analysis at breadth→depth produce useful new questions, or just paraphrases of sub-questions?** Verify on the first real S3 run. If the LLM keeps proposing things already covered, tighten the prompt to require novel-vs-contract.
- **Are the source-quality weights right?** They're untested. The first real run will show whether vc-blog at 0.7 is too generous or too harsh against, e.g., a16z; whether vendor at 0.5 actually demotes unity-connect-class sources enough.
- **Should the domain-saturation penalty apply to seed questions, or only to follow-up proposals?** Initial seeds come from `decompose.ts` before any corpus exists; they can't be saturation-checked. Probably restrict the penalty to follow-ups (where corpus exists). Easy.
- **How aggressive should contract revision be?** A loose prompt ("anything weird?") will mutate the contract too much; a tight one will rarely change anything. Start tight, loosen if first runs show genuine drift.
- **Frontier-time vs proposer-time scoring of source quality?** Frontier-time means we already know the question's likely domain (heuristic); proposer-time means we know after the LLM picks. Probably do both at low cost.

## Suggested openspec change name

`research-quality`

---

## What actually shipped

S3's three core pieces (gap analyzer, contract revision, proposer fresh-bias) all fire correctly. Smoke run telemetry confirms: 5 gaps pushed at breadth→depth, 2 contract revisions with sensible removed/added items, source diversity materially shifted (12 distinct domains, no source cited more than 4×).

**Bug found and fixed during smoke**: the boundary hook was originally placed at the *top* of each main-loop iteration. When iter 1 happened to consume the entire deadline (LLM was slow on the first attempt; ~20s/call avg with one 104s outlier), the loop never reached iter 2 to fire the hook. Fixed by (a) generalizing `maybeRunBoundaryHook` to walk every boundary skipped between `lastObserved` and `current` (mirrors phaseMachine's existing event-synthesis pattern), and (b) calling the hook at end-of-iteration AND once after the main loop exits. Re-run produced 5 iterations and the expected hook fires.

**Substantive bar — partial:** named players (TCS / Infosys / Accenture / Cognizant / Wipro / Genpact) and GCC / captive centres are *still* not in the resulting report. The gap-analyzer pushed 5 new seeds, but the LLM didn't specifically propose "named-player revenue" or "TCS pricing structure" angles. The mechanism worked; the prompt's content was the limiter. Two follow-ups, both small, address it:

1. **Tighten the gap-analyzer prompt** to explicitly enumerate "named industry players in the relevant industry" and "specific quantitative figures from named companies" as priority angles. One-string change in `src/gap.ts`'s `SYSTEM_PROMPT`.
2. **Log the actual gap questions** in the `gap.analyzed` event payload (currently only counts are stored). Diagnostic improvement that lets us see *what* the LLM proposed, not just *how many*. Three-line change in `src/gap.ts`.

These two are bundled with two leftover S2 follow-ups in [v2 follow-ups](./v2-tuning-followups.md) — a single small change can absorb all four when worth it.
