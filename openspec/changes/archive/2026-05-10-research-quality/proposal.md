# Proposal — research-quality

## Why

S2's smoke run on the canonical question produced a sharp, on-thesis report — but the brutal-editor rubric flagged `has_example=false` on most sections because the corpus *itself* lacked named-player evidence (TCS, Infosys, Accenture, Cognizant, Wipro, Genpact, etc., were entirely absent from the gathered facts). The thesis-drafter and per-claim retrieval did everything they could with what they had; the gap is upstream, in *what gets gathered*. v1's gathering loop has three structural blind spots: the proposer sees `factStore.list({limit:8})` ordered by `created_at DESC` (a thread, just-scraped, reinforces itself), the scorer has no source-quality or domain-diversity signal (one site can dominate the corpus), and there's no point in the run where the agent asks "what angles relevant to the task are *not yet covered*?". This change adds gap analysis at phase boundaries, source-weighted + diversity-penalised scoring, the proposer fresh-bias fix, and contract revision at phase boundaries.

## What Changes

- **NEW** `gap-analyzer` capability: at breadth→depth (and optionally depth→synthesis) phase boundaries, one `llm.fast` call receives the original task, the contract's `core_question` + `sub_questions` + `good_answer_contains` + `out_of_scope`, and a sampled cross-section of facts (~30-50, picked for source diversity and task-relevance, NOT recency). It returns 3-5 new questions — concrete searchable angles the corpus is missing — which are pushed onto the frontier as fresh seeds with `topicTag: 'gap'`. Tagged so we can attribute outcomes downstream.
- **MODIFIED** `followup-proposer`: input slice swaps from `factStore.list({limit:8}, ORDER BY created_at DESC)` to a task-relevance-sampled slice (`factStore.findSimilar(taskEmbedding, topK=16)` then domain-cap to 8 with max 2 per domain). This is the load-bearing fresh-bias fix — the proposer no longer reinforces whichever vendor was *just* scraped. The prompt also receives a `<saturated_domains>` hint listing domains where the corpus is over-represented (≥40% share OR >5 facts), and is instructed to bias toward questions likely to surface different sources. The `<recent_claims>` block becomes `<task_relevant_claims>` to match the new input shape.

> **Note: scorer is intentionally NOT modified in S3.** Frontier candidates don't have a source until they're scraped, so a source-quality factor at the scorer has no clean semantics. Domain-saturation and source-quality both live at the proposer (LLM-level bias against saturated domains via the `<saturated_domains>` hint) and at S2's per-claim retrieval (already in place — `cosine + α·source_weight − β·domain_repeat` in synthesize.ts). If the proposer-level bias proves too soft after first-run telemetry, a deterministic scorer penalty using the parent question's domain could be a follow-up — deferred until evidence demands it.
- **MODIFIED** `research-contract`: gains a `reviseContract(facts, currentContract)` function called at each phase boundary. One `llm.fast` call returns a revised `out_of_scope` array (full replacement; can also remove items proven relevant). Re-embeds the new OOS items and replaces the in-process cache. Past insertions are NOT retroactively dropped — synthesis-time per-claim retrieval already favours task-relevant facts.
- **MODIFIED** `event-log`: `EventKind` extended with `gap.analyzed` (L4, emitted by gap-analyzer per phase boundary) and `contract.revised` (L5, emitted on each phase-boundary contract update). `format.ts` gets matching cases.

Not BREAKING. The scorer's new parameters are optional with safe defaults; existing call sites continue to work.

## Capabilities

### New Capabilities

- `gap-analyzer`: phase-boundary "what's missing?" pass. Inputs: original task, contract, sampled facts. Output: 3-5 new seed questions with `relevance` and `why` fields, pushed onto the frontier with `topicTag: 'gap'`. Lives in `src/gap.ts`.

### Modified Capabilities

- `followup-proposer`: input fact slice changes from recency-sorted to task-relevance-sampled with a per-domain cap (the load-bearing fresh-bias fix); prompt gains a `<saturated_domains>` hint instructing the model to bias against over-represented sources.
- `research-contract`: gains `reviseContract(facts, currentContract)` for phase-boundary OOS updates. Existing readers (`getContract`, `getOutOfScopeEmbeddings`) carry through with an in-process cache invalidation when the contract is revised.
- `event-log`: `EventKind` extended with `gap.analyzed` and `contract.revised`; formatter gets matching cases.

## Impact

**Code**: new module `src/gap.ts`. Touched files: `src/propose.ts` (input slice swap + saturated-domains hint), `src/contract.ts` (add `reviseContract`), `src/research.ts` (wire phase-boundary gap analysis + contract revision into `runResearch`), `src/events.ts` + `src/format.ts` (new kinds + formatter cases). `src/score.ts` is intentionally untouched (see note in §What Changes).

**APIs**: no external surface; same internal patterns. The proposer's input shape changes but the function signature is preserved — `research.ts` constructs the new slice before passing in.

**Run-time cost**: gap-analyzer adds 1 `llm.fast` call per phase boundary (~10s × 2 boundaries = ~20s total). Contract revision adds 1 `llm.fast` per boundary (~5-10s × 2 = ~10-20s total). Combined: ~40s of additional run-budget consumption — bounded and worth the angles it surfaces. The fresh-bias proposer fix is zero-cost (just a different DB query).

**Dependencies**: S1 (contract module + sources table + task embedding) and S2 (per-claim source-weight ranking shares this infrastructure) are both shipped. No new packages; same `llm.fast` + JSON-schema + retry-once pattern.

**Risk**: gap analyzer hallucinates angles that aren't actually missing → the resulting frontier seeds search for nothing useful and waste depth-phase iterations. Mitigation: tight prompt requiring concrete search-engine-answerable questions; first-run telemetry tunes the prompt. Contract revision drift (`out_of_scope` mutates too aggressively, accidentally excluding legitimate adjacent content) → mitigation: the revision prompt requires keeping items unless they're proven relevant; first-run telemetry tunes. Proposer fresh-bias fix changes its input shape — risk that the LLM gets confused with the new `<task_relevant_claims>` block name, mitigated by trivially keeping the same block content type (claim text).

**Out of scope** (deferred to S4 or follow-up): living-hypothesis revision across iterations (S4), triangulation budget perf fix from S2's smoke (independent follow-up), banned-closer-words deterministic post-processor (independent follow-up), redundancy detection / early-synthesis trigger (deferred for now).
