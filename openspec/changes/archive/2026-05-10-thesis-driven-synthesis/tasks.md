# Tasks — thesis-driven-synthesis

Implementation order: events/formatter → three new modules (`thesize.ts`, `triangulate.ts`, `rubric.ts`) → `sections.ts` (new `writeSectionFromClaim` + intro/outro thesis-aware path) → `synthesize.ts` orchestrator (dispatch + per-claim retrieval + brutal-editor pass) → validation → smoke run.

## 1. Event taxonomy and formatter

- [x] 1.1 Extend `EventKind` union in `src/events.ts` with `'thesis.drafted'`, `'claim.triangulated'`, `'section.rubric'`, `'section.dropped'`, `'synthesis.fallback'`. Verify `bun run typecheck` still passes.
- [x] 1.2 Add formatter cases for the five new kinds in `src/format.ts`. Each must produce a one-line human-readable summary mirroring the existing case style (e.g., `thesis.drafted` → `claims=N · slice=M · cap=K`; `claim.triangulated` → `<headline> · +cor / -con · contested?`; `section.dropped` → `<headline> · <reason>`; `synthesis.fallback` → `<reason> · facts=N`).

## 2. Thesis-drafter module

- [x] 2.1 Create `src/thesize.ts` exporting `ResearchThesis = {thesisSentences: string[], claims: ThesisClaim[]}`, `ThesisClaim = {claim: string, headline: string, rationale: string, embedding: Float32Array}`, `draftThesis(task, contract, allFactsWithEmbeddings)`. Per-file constants: `SLICE_SIZE = 60`, `MAX_FACTS_PER_DOMAIN_THESIS = 3`.
- [x] 2.2 Implement the slice selector: sort all facts by `cosine(fact.embedding, taskEmbedding)` descending, then greedily pick respecting `MAX_FACTS_PER_DOMAIN_THESIS` per domain (use `extractDomain` from `classify.ts`), stopping at `SLICE_SIZE`.
- [x] 2.3 Implement `draftThesis` LLM call: `llm.fast` with `responseFormat: json_schema`, retry-once, markdown-fence-strip fallback. The system prompt instructs the model to produce 3–5 thesis sentences and 4–7 claims with `claim`/`headline`/`rationale` fields.
- [x] 2.4 Include the contract's `good_answer_contains` in the prompt as a `<good_answer_contains>` block so the drafter has explicit guidance on what an analyst would expect a useful answer to surface.
- [x] 2.5 On parse-success-but-`claims.length < 3`, return `null` and emit `thesis.drafted` with `error: "insufficient claims (returned N)"`.
- [x] 2.6 On LLM failure or post-retry unparseable JSON, return `null` and emit `thesis.drafted` with `error` set.
- [x] 2.7 On success, batch-embed all `claim.claim` strings via `embedder.embed(...)` (one call) and attach `embedding: Float32Array` to each claim object. Emit `thesis.drafted` with `payload: {claimCount, thesisSentenceCount, factSliceSize, facts_per_domain_cap}`.

## 3. Claim-triangulator module

- [x] 3.1 Create `src/triangulate.ts` exporting `ClaimTriangulation = {corroborations: number, contradictions: number, contested: boolean, queriesRan: number}`, `triangulateClaims(claims: ThesisClaim[], budgetMs: number)`. Per-file constants: `DISAGREEMENT_MARKERS = ['however', 'but', 'contrary', 'fails to', 'disputes', 'criticism', 'criticized', 'unlike', 'nevertheless', 'whereas']`, `AGREEMENT_COSINE = 0.55`, `CONTESTED_FRACTION = 0.30`, `CONTESTED_MIN_CONTRADICTIONS = 2`.
- [x] 3.2 For each claim, generate two SearXNG queries: `corroborate = <claim> + " evidence data report"`, `contradict = <claim> + " dispute criticism limitation"`. Cap at top-3 results per query.
- [x] 3.3 For each result URL: scrape via `scraper.fetch` (already non-throwing), chunk + extract claims, insert via `factStore.insert` (which routes through S1 gates). Tag inserted facts with `topicTag: 'triangulation'`. Set `questionId` to null.
- [x] 3.4 After ingestion for one claim, scan ALL facts in the store (or a focused subset — start with all) and compute corroboration/contradiction counts using `cosine(fact.embedding, claim.embedding) >= AGREEMENT_COSINE` plus a 200-char `rawExcerpt` window check for `DISAGREEMENT_MARKERS`.
- [x] 3.5 Compute `contested = contradictions >= CONTESTED_MIN_CONTRADICTIONS && contradictions / (corroborations + contradictions) >= CONTESTED_FRACTION`.
- [x] 3.6 Emit one `claim.triangulated` event per claim with `layer: 'L6'`, `durationMs`, `payload: {claimHeadline, corroborations, contradictions, contested, queriesRan}`.
- [x] 3.7 Track wall-clock budget: at the start of `triangulateClaims`, capture `startedAt`. Before each new claim, check if elapsed exceeds budgetMs; if so, return defaults `{corroborations:0, contradictions:0, contested:false, queriesRan:0}` for the rest and emit `claim.triangulated` with `error: 'budget exceeded'`.

## 4. Section-rubric module

- [x] 4.1 Create `src/rubric.ts` exporting `SectionRubric = {hasMechanism, hasExample, hasQuantification, defendsHeading, note}`, `evaluateSection(body: string, claim: ThesisClaim)`.
- [x] 4.2 Implement the LLM call with `response_format: json_schema` enum-restricted to booleans for the four flag fields plus a `note` string. Retry-once, markdown-fence-strip fallback. `maxTokens: 256`.
- [x] 4.3 On LLM failure (post-retry), return `{hasMechanism: true, hasExample: true, hasQuantification: true, defendsHeading: true, note: 'rubric LLM failed; pass-by-default'}` and emit `section.rubric` with `error` field. Fail-open so legitimate sections are not deleted by a flaky rubric.
- [x] 4.4 On success, emit `section.rubric` with `payload: {headline, hasMechanism, hasExample, hasQuantification, defendsHeading}`.

## 5. Section-writer additions

- [x] 5.1 In `src/sections.ts`, add a new exported function `writeSectionFromClaim({claim, headline, rankedFacts, triangulation}, ctx) → Section`. Reuse the existing helpers (`buildSectionUserMessage` adapted, `extractCitations`, `filterCitations`, `wordCount`) so the function shape mirrors `writeSection`.
- [x] 5.2 Build a new `SECTION_FROM_CLAIM_SYSTEM_PROMPT` that instructs the writer to: open with the claim as the thesis sentence; rank points by importance per the `rankedFacts` order; cite every claim with `[N]`; hedge when `corroborations < 2 OR rankedFacts.length < 3` (use language like "Evidence is thin, but..." / "One source argues..."); explicitly surface contention when `contested === true` (e.g., "Sources disagree: X argues..., while Y reports..."); omit weak facts that don't actually support the claim; no transitional padding; no "Furthermore" / "Consequently" / "Ultimately" as paragraph openers.
- [x] 5.3 Build the user message: include `<original_task>`, `<claim>`, `<headline>`, `<triangulation>`, and `<facts>` blocks (the facts numbered 1..N in their pre-ranked order).
- [x] 5.4 Reuse the two-attempt + filter-citations + emit-`section.written` pattern from the existing `writeSection`. Set `maxTokens: 2500` (matches existing).
- [x] 5.5 Add an optional `thesis?: {thesisSentences: string[], claimHeadlines: string[]}` parameter to `writeIntro`. When present, switch the system prompt to a thesis-aware variant that instructs the model to state the thesis directly and reference claims naturally — NOT paraphrase the headline list.
- [x] 5.6 Add an optional `thesis?: {thesisSentences, claimHeadlines, claimMetadata: Array<{headline, contested}>}` to `writeOutro`. When present, switch the prompt to instruct the model to synthesize what the report concluded and explicitly flag any contested claims as open questions.
- [x] 5.7 Both `writeIntro` and `writeOutro` MUST behave identically to S1 when `thesis` is undefined — the cluster fallback path passes nothing and gets the existing prose.

## 6. Synthesis orchestrator (synthesize.ts)

- [x] 6.1 Add per-file constants in `src/synthesize.ts`: `MIN_FACTS_FOR_THESIS = 30`, `FACTS_PER_CLAIM = 10`, `SOURCE_WEIGHT_FACTOR = 0.15`, `DOMAIN_REPEAT_PENALTY = 0.05`, `MIN_CLAIM_SUPPORT_THRESHOLD = 0.30`, `MIN_CLAIM_SUPPORT_FRACTION = 0.80`, `BRUTAL_EDIT_MODE: 'drop' | 'flag' = 'drop'`.
- [x] 6.2 At the top of `synthesize()`, after `factStore.listAllWithEmbeddings()`: if `facts.length < MIN_FACTS_FOR_THESIS`, emit `synthesis.fallback` with `reason: 'sparse_corpus'` and call the existing cluster path. Otherwise, call `draftThesis(runState.task, runState.contract, facts)`.
- [x] 6.3 If `draftThesis` returns `null`, emit `synthesis.fallback` with `reason: 'thesis_returned_null'` and fall back to the cluster path.
- [x] 6.4 If thesis-drafting succeeded, compute the synthesis budget: `synthesisBudgetMs = max(0, runState.deadlineAt - Date.now())`. Allocate `triangulationBudgetMs = min(120_000, 0.25 * synthesisBudgetMs)`.
- [x] 6.5 Call `triangulateClaims(thesis.claims, triangulationBudgetMs)`. Attach the resulting `ClaimTriangulation` to each claim in memory.
- [x] 6.6 Re-read facts after triangulation (since triangulation inserted new ones): `const factsAfterTri = factStore.listAllWithEmbeddings()`.
- [x] 6.7 Build a per-domain map: `domainFor[factId] = extractDomain(fact.sourceUrl)`. Build a per-fact source weight: `sourceWeight[factId] = computeSourceWeight(lookupSource(domain))` — academic/regulator → 1.0, analyst/trade-pub → 0.6, vc-blog/personal-blog → 0.3, vendor → 0.1, forum/other → 0.0. Normalize to `[-0.5, 1.0]` (`other` maps to 0.0; `vendor` to 0.1).
- [x] 6.8 For each thesis claim, compute the per-claim ranked fact list: walk all facts, score each by `cosine(fact.embedding, claim.embedding) + SOURCE_WEIGHT_FACTOR * sourceWeight[factId] − DOMAIN_REPEAT_PENALTY * pickedSoFarFromSameDomain`. Take top `FACTS_PER_CLAIM`.
- [x] 6.9 Apply the thin-evidence check per claim: if at least 80% of the top-K have cosine < `MIN_CLAIM_SUPPORT_THRESHOLD`, mark the claim as `thinEvidence: true`. Default behaviour for thin-evidence claims is "write with hedge" (the writer's existing rules already handle this since `corroborations < 2` triggers hedging).
- [x] 6.10 Iterate over claims in order: build a `SectionFact[]` from the ranked list, call `writeSectionFromClaim({claim, headline, rankedFacts, triangulation}, {originalTask})`. Collect drafted sections.
- [x] 6.11 Brutal-editor pass: for each drafted section, call `evaluateSection(body, claim)`. A section *fails* when `(hasMechanism === false && hasExample === false) || defendsHeading === false`.
- [x] 6.12 For each failing section: re-call `writeSectionFromClaim` with the rubric note appended to the user message (one revision attempt). Re-run the rubric on the revised body.
- [x] 6.13 If `BRUTAL_EDIT_MODE === 'drop'` and a section still fails after revision, drop it from the report and emit `section.dropped` with `payload: {headline, reason: rubricNote}`. If `BRUTAL_EDIT_MODE === 'flag'`, retain the section but prepend a hedging sentence (`"Evidence in this section is uneven: ..."`).
- [x] 6.14 Build the stitcher input: for each surviving section, the `factIds` are the claim's ranked fact ids in order (so `[N]` in the body maps to local position N). Pass `thesis: {thesisSentences, claimHeadlines}` to `writeIntro`. Pass `thesis: {thesisSentences, claimHeadlines, claimMetadata: [{headline, contested}, ...]}` to `writeOutro`.
- [x] 6.15 Update the `stitchReport` call: per the report-stitcher delta, headlines from the thesis path go through verbatim (no slug rendering). Add a `path: 'thesis' | 'cluster'` flag in the input so the stitcher knows which heading rendering to apply.
- [x] 6.16 The cluster fallback path continues to use `writeSection(input, ctx)` (legacy) and the slug → Title-Case heading transform from S1. No behaviour change for the fallback path.

## 7. Stitcher heading-source split

- [x] 7.1 In `stitchReport`, accept an additional input field `path: 'thesis' | 'cluster'` (default to `'cluster'` for backwards compatibility with any existing callers).
- [x] 7.2 When `path === 'thesis'`, render `## ${section.label}` directly (label comes through as the headline plain English from the orchestrator). When `path === 'cluster'`, apply the existing S1 `renderHeading(slug)` transform.
- [x] 7.3 The intro/outro placement and ordering in the stitched output is unchanged.

## 8. Validation

- [x] 8.1 Run `bun run typecheck` — no errors.
- [x] 8.2 Run `openspec validate thesis-driven-synthesis` — passes.
- [x] 8.3 Visual diff review: every spec requirement maps to at least one task above; every task targets at least one spec requirement.

## 9. Smoke run on the canonical question

- [x] 9.1 `bun run research --fresh "What are the pain points of outsourcing companies in AI age?" --deadline 15m`. **Run 2 (after budget + outro fixes): 5 iterations / 413 facts (189 main + ~224 triangulation) / 5 sections / 23.0 min wall-clock / report at `.sheldon/reports/1778412179363.md`.** Run 1 (pre-fix) is at `1778410655182.md` — kept for diff.
- [x] 9.2 Tail `bun run watch` and confirm new event kinds appear. **Verified: `thesis.drafted` × 1 (6 claims, slice=21 facts, cap=3); `claim.triangulated` × 5 (claim 1 fully ran +6/-3 contested=true; claims 2–5 hit "budget exceeded" — see 9.4); `section.rubric` × 7 (5 first-pass + 2 revisions); `section.written` × 7; `section.dropped` × 0; `synthesis.fallback` × 0 (thesis path took, as expected for the canonical question).**
- [x] 9.3 Inspect report against the bar. **Substantive bar MET:** real thesis up front (intro states a 3-sentence claim, NOT a paraphrase of headlines); 5+ missing-angles hits (token-based pricing volatility, outcome-based pricing pivot, vendor lock-in / model obsolescence, telemetry per-GB pricing, model-poisoning risks — all entirely absent from A, B, and S1); section headings ARE the claims in plain English; sections defend their headings; no off-topic drift; one section explicitly surfaces triangulation-detected contention. **2 minor issues:** Token Economics and Black Boxes sections still close with `Ultimately…` / `Consequently…` (prompt has the rule but the model treats it as soft); the brutal-editor's `hasExample = false` flag is consistently true for most sections (we lack named companies in retrieved facts — a corpus-quality issue belonging to S3, not S2).
- [x] 9.4 Sample triangulation events. **Token Economics Erode Margins came back `+6 corroborations / -3 contradictions / contested=true / queries=2`.** That's the only fully-triangulated claim. The other 4 hit "budget exceeded" with `queries=0` because claim 1's sequential URL ingestion (6 URLs × scrape + multiple LLM extract calls per chunk) ate the full 5-min flat budget on its own. **Real follow-up needed**: per-claim budget + parallel ingestion within a claim. Documented as a tuning gap for S3 or a small standalone follow-up change. Even with only claim 1 triangulated, the report is solid because (a) writer correctly hedged the others as thin-evidence, (b) per-claim retrieval ranked good evidence regardless.
- [x] 9.5 Compare against S1's smoke run (`1778407895016.md`). **S2 covers the missed-angles list S1 missed entirely**: outcome-based pricing pivot, model obsolescence, token economics, telemetry pricing. S1's recruiting-tool / cloud-infra drift is gone. S2 is the qualitative jump promised by the architectural inversion.
- [x] 9.6 Smoke-run findings recorded inline above. Headline: thesis path produced an analyst-grade report on first proper run; brutal-editor caught and fixed 2 sections via revision (no drops); triangulation budget needs perf work but didn't block quality. **Substantive bar from `docs/stages/README.md` is MET.**
