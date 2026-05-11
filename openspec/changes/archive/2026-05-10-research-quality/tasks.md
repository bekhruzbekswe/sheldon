# Tasks — research-quality

Implementation order: events/formatter → contract revision (`contract.ts`) → gap-analyzer module (`gap.ts`) → proposer fresh-bias fix + saturated-domains hint (`propose.ts`) → orchestration in `research.ts` (phase-boundary hooks + saturated-domains computation) → validation → smoke run.

## 1. Event taxonomy and formatter

- [x] 1.1 Extend `EventKind` union in `src/events.ts` with `'gap.analyzed'` and `'contract.revised'`. Verify `bun run typecheck` still passes.
- [x] 1.2 Add formatter cases for the two new kinds in `src/format.ts`. `gap.analyzed` summary shape: `<phaseTransition> · proposed=N · pushed=M · deduped=K` (with `err` fallback on error). `contract.revised` summary shape: `<phaseTransition> · -X +Y` showing counts of removed and added OOS items (with `err` fallback).

## 2. Contract revision (contract.ts)

- [x] 2.1 In `src/contract.ts`, add `reviseContract(currentContract, droppedSamples, repeatedClaimsSamples)` exported. Returns `Promise<ResearchContract>` (revised contract, or unchanged on LLM failure).
- [x] 2.2 Implement the revision LLM call: `llm.fast` with `responseFormat: json_schema`, retry-once, markdown-fence-strip fallback. The schema requires only the `out_of_scope: string[]` field on the response (the function returns the merged contract: existing fields preserved, only `out_of_scope` replaced).
- [x] 2.3 Build the system prompt: instruct the model to KEEP existing OOS items unless gathered evidence has proven them irrelevant; ADD new items only for adjacencies that consistently slipped through and turned out to be off-topic; OOS items must be CONCRETE phrases (≤8 words), not vague descriptors. Reuse the existing OOS-quality language from the contract drafter's prompt.
- [x] 2.4 Build the user message: `<current_contract>` block (the full JSON), `<dropped_samples>` block (≤10 examples of recently dropped facts with their score and OOS-similarity), `<repeated_borderline_claims>` block (≤10 examples of inserted facts that score near `T_DROP`).
- [x] 2.5 On success, write the merged JSON back to `run_state.contract_json` via `getDb().prepare('UPDATE run_state SET contract_json = ? WHERE id = 1').run(...)`. Invalidate the in-process caches (`contractCache`, `oosEmbCache`) by setting them to null.
- [x] 2.6 On LLM failure (post-retry), do NOT mutate the contract; emit `contract.revised` with `error` populated; return the input contract unchanged.
- [x] 2.7 Always emit one `contract.revised` event with `payload: {phaseTransition, oosBefore, oosAfter, removed, added}` (success path) or with `error` (failure path).

## 3. Gap-analyzer module (gap.ts)

- [x] 3.1 Create `src/gap.ts` exporting `Gap = {question: string, relevance: number, why: string}`, `analyzeGaps(phaseTransition, task, contract, allFactsWithEmbeddings)`. Per-file constants: `GAP_SLICE_SIZE = 40`, `GAP_MAX_PER_DOMAIN = 3`.
- [x] 3.2 Implement `selectGapSlice` mirroring `thesize.ts`'s shape: sort facts by `cosine(fact, taskEmbedding)` descending, greedy pick with per-domain cap. Use `getTaskEmbedding()` from S1's contract module. (Copy the small selector — extracting to a shared util would couple thesize/gap unnecessarily.)
- [x] 3.3 Implement the LLM call: `llm.fast` with `responseFormat: json_schema`, retry-once, markdown-fence-strip fallback. Response shape: `{gaps: [{question, relevance, why}, ...]}`. Cap output at 5 entries.
- [x] 3.4 Build the system prompt per the spec's "Gap-analyzer prompt requires concrete searchable angles" requirement: forbid generic meta; require concrete searchable questions; explicitly mention this is about ADDING coverage of missing angles, NOT restating existing sub-questions.
- [x] 3.5 Build the user message: `<task>`, `<core_question>`, `<sub_questions>`, `<good_answer_contains>`, `<out_of_scope>`, `<facts>` block (the slice).
- [x] 3.6 On success: for each parsed gap, embed the question via `embedder.embed([gap.question])`, compute `score({relevance, novelty, depth: 0, phase: currentPhase()})` against existing frontier embeddings, push via `frontier.push(...)`. Track inserted vs deduped counts.
- [x] 3.7 On parse failure or zero valid gaps, emit `gap.analyzed` with `error` populated and return without pushing anything.
- [x] 3.8 Always emit one `gap.analyzed` event with `payload: {phaseTransition, gapsProposed, gapsPushed, gapsDeduped}` (success) or with `error` (failure).

## 4. Proposer fresh-bias fix + saturated-domains hint (propose.ts)

- [x] 4.1 In `src/propose.ts`, rename the `ProposeContext.recentClaims` field to `taskRelevantClaims` and add an optional `saturatedDomains: string[]` field. Update the type export.
- [x] 4.2 Update `buildUserMessage` to consume `taskRelevantClaims` instead of `recentClaims` (the underlying logic — truncate to ≤200 chars, ≤10 entries — is unchanged). The `<recent_claims>` XML block name becomes `<task_relevant_claims>`.
- [x] 4.3 When `saturatedDomains` is non-empty, append a `<saturated_domains>` block to the user message listing each saturated domain on its own line.
- [x] 4.4 Update the system prompt to add: "If a `<saturated_domains>` block is present, bias your proposed questions toward angles that would surface different sources. Don't reject saturated domains entirely; just don't disproportionately produce questions that look like they'd return more from the same domain."

## 5. Orchestration in research.ts (phase-boundary hooks)

- [x] 5.1 In `src/research.ts`, add a `lastObservedPhase: Phase` local variable to `runResearch`, initialized to `'breadth'` (or the resume phase on the resume path).
- [x] 5.2 Add a `maybeRunBoundaryHook(currentPhase: Phase)` async helper. On `currentPhase !== lastObservedPhase`, run gap-analyzer (`analyzeGaps('breadth->depth' or 'depth->synthesis', ...)`) followed by `reviseContract(...)` IF the new phase is not already `'synthesis'` with the frontier locked. After both run, set `lastObservedPhase = currentPhase`.
- [x] 5.3 Invoke `await maybeRunBoundaryHook(currentPhase())` once per iteration, at the top of `processIteration` BEFORE `frontier.pop()`. This ensures any gap-analyzer pushes are eligible for the iteration that just transitioned.
- [x] 5.4 Build the input slices for the proposer: replace `factStore.list({limit: RECENT_CLAIMS_FOR_PROPOSER})` with a `findSimilar`-based + domain-cap construction. New helper `buildTaskRelevantSlice(taskEmbedding, RECENT_CLAIMS_FOR_PROPOSER, maxPerDomain=2)` lives in research.ts.
- [x] 5.5 If `getTaskEmbedding()` returns null (defensive carve-out for partial-state runs), fall back to the legacy recency-sorted slice. Document in a code comment.
- [x] 5.6 Compute `saturatedDomains` for each proposer call: helper `getSaturatedDomains(threshold=0.40, minCount=5)` runs `SELECT count(*), source_url FROM facts GROUP BY 1`, extracts domains via `extractDomain`, and returns the list of domains exceeding `(count/total > threshold OR count > minCount)`.
- [x] 5.7 Pass `taskRelevantClaims`, `saturatedDomains` into `proposer.propose(...)` alongside the existing `originalTask`, `parentQuestion`, `pendingTitles`.

## 6. Resume-path integration

- [x] 6.1 On the resume path, `lastObservedPhase` MUST be set to the run's recovered phase (from `seedPhaseCache(restorePhase)`'s argument), so the boundary hook doesn't fire spuriously. Add a corresponding initialization line in the resume-path branch of `runResearch`.

## 7. Validation

- [x] 7.1 Run `bun run typecheck` — no errors.
- [x] 7.2 Run `openspec validate research-quality` — passes.
- [x] 7.3 Visual diff review: every spec requirement maps to at least one task above; every task targets at least one spec requirement.

## 8. Smoke run on the canonical question

- [x] 8.1 `bun run research --fresh "..." --deadline 15m`. **First run hit a real bug: the boundary hook only fired between iterations, but iter 1 ate the entire deadline (LLM ~20s/call today, with one 104s outlier) — so 0 gap.analyzed and 0 contract.revised events fired.** Fixed by (a) generalizing `maybeRunBoundaryHook` to walk *every* boundary skipped between `lastObserved` and `current` (mirrors phaseMachine's behaviour), and (b) calling the hook at end-of-iteration AND once after the main loop exits. **Re-run: 5 iterations, 27.6 min, 443 facts, 6 sections, report at `.sheldon/reports/1778421455988.md`.**
- [x] 8.2 New event kinds confirmed firing: `gap.analyzed × 1` at breadth→depth (5 gaps proposed, 5 pushed, 0 deduped); `contract.revised × 2` (breadth→depth removed 5 OOS items and added 3; depth→synthesis removed 3 added 3 — sensible refinements, not churn). The proposer's `<saturated_domains>` hint also fired during depth-phase iterations as the corpus accumulated.
- [x] 8.3 Substantive bar: PARTIAL. **Wins:** real thesis up front; 4 missing-angle hits (HITL cost erosion, outcome-based pricing pivot, knowledge migration in-house, EU AI Act regulatory pressure); section headings ARE the claims; no off-topic drift. **Source diversity materially better than S2** — 12 distinct domains in the report, no single source cited more than 4 times (vs A's a16z 14×, B's aalpha 15×, S2's top 5×). **Loss:** named players (TCS/Infosys/Accenture/Cognizant/Wipro/Genpact) still absent; GCC/captive centers also still missing. The gap-analyzer pushed 5 new seeds but only ~6 min remained; 3 of 4 post-gap iterations came up dry.
- [x] 8.4 Compared against S2's smoke run (`.sheldon/reports/1778412179363.md`). S2 surfaced 5 missing angles (token economics, outcome pivot, vendor lock-in, telemetry pricing, model poisoning); S3 surfaced 4 (different mix, with HITL erosion and knowledge migration newly explicit). **S3 source diversity is the clearest improvement** — no domain dominates; sources span analyst (PwC), regulator (EU), academic (YJOLT), trade-pub, and a few vendor blogs. Contract revision evolved `out_of_scope` sensibly across both boundaries.
- [x] 8.5 Gap-analyzer event payloads only carry COUNTS (gapsProposed/Pushed/Deduped), not the actual questions. **Follow-up: log the actual gap questions in the payload for next-run diagnosis.** From the iteration outcomes, it's clear the LLM proposed adjacent angles (some yielded `no-sources`, others `facts+=0`), but we can't tell from telemetry whether it specifically proposed "TCS pricing" / "Infosys responses" / "GCC competition" — the content of the gap questions is the unknown.
- [x] 8.6 Contract revision content reviewed: at breadth→depth removed mostly genuinely-irrelevant items ("Historical overview of outsourcing before 2010", "Consumer trends in using AI chatbots") and added concrete adjacencies the corpus learned were noise ("Generic procurement budget projections"). At depth→synthesis further refined — items added/removed both look like real-evidence-driven decisions, not random churn.
- [x] 8.7 Smoke findings recorded inline. **S3's machinery (boundary hook, gap analyzer, contract revision, proposer fresh-bias) all FIRE correctly and produce sensible structural improvements.** Source diversity bar met. Named-players bar not yet met — needs prompt-level tuning (gap-analyzer prompt to enumerate "named industry players" as a priority angle). Two follow-ups identified: tighten gap-analyzer prompt + log actual gap questions in payload. These plus S2's two follow-ups (triangulation budget perf, banned-closer post-processor) can be bundled into a small standalone "v2-tuning" change.
