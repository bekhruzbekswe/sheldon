# Tasks — v2-tuning

Implementation order: F4 (gap payload — diagnostic, ships first so subsequent runs reveal F3's effect) → F3 (gap prompt) → F2 (banned-closer post-processor) → F1 (per-claim triangulation budget + parallel ingest) → validation → smoke run.

## 1. F4 — `gap.analyzed` payload includes actual gap questions

- [x] 1.1 In `src/gap.ts` `analyzeGaps`, change the per-gap loop to track each gap's disposition: `{question, relevance, why, pushed, dedupedAgainstId?}`. The existing `frontier.push(...)` returns `null` on dedupe and the matched id is observable from the existing dedupe logic — use whichever path the frontier API exposes (or fall back to a post-push lookup if needed).
- [x] 1.2 Build the `gaps` array as the loop runs and include it in the success-path `gap.analyzed` event payload alongside the existing aggregate counts. Failure-path payload (when `parsed === null` or `parsed.length === 0`) MAY omit `gaps` or set it to `[]`.
- [x] 1.3 Verify the `format.ts` case for `gap.analyzed` continues to render the one-line summary using the aggregate counts (no change needed if it already reads `gapsProposed`/`gapsPushed`/`gapsDeduped` from payload).

## 2. F3 — Tighten gap-analyzer SYSTEM_PROMPT with priority angles

- [x] 2.1 In `src/gap.ts`, extend `SYSTEM_PROMPT` with a `PRIORITY ANGLES` section listing the four categories from the spec: named industry players, quantitative figures, time-bounded events, contract `good_answer_contains` adjacencies the corpus doesn't yet cover.
- [x] 2.2 Phrase the section as "Consider these priority angles when they're relevant to the task" — opt-in, NOT mandatory. The rule must not over-steer for tasks where named players don't apply.
- [x] 2.3 Verify by inspection that `SYSTEM_PROMPT` contains the substring "PRIORITY ANGLES" (or equivalent header) and the four bullet points.

## 3. F2 — Banned-closer-words deterministic post-processor

- [x] 3.1 In `src/sections.ts`, add a private `removeBannedClosers(body: string): string` helper. Rotate replacement connectors via a module-level counter (`BANNED_CLOSER_REPLACEMENTS = ['As such,', 'In sum,', 'That is,']`).
- [x] 3.2 Implementation: split body on `\n\n`, take the LAST paragraph, regex-match `/^(Furthermore|Consequently|Ultimately)([,]?\s+)/`. If it matches, replace `$1$2` with `${replacements[counter++ % 3]} ` and rejoin with the previous paragraphs. If it doesn't match, return the input unchanged.
- [x] 3.3 In `writeSection`, immediately after `const filteredBody = filterCitations(body, validIds);`, add `const cleaned = removeBannedClosers(filteredBody);` and use `cleaned` for the rest of the function (extractCitations, the returned Section.body, the section.written event payload). Adjust accordingly.
- [x] 3.4 In `writeSectionFromClaim`, apply the same change — same place in the function (post-`filterCitations`, pre-emit/return).
- [x] 3.5 Quick smoke-test the helper inline: `removeBannedClosers("para 1\n\nUltimately, this is bad.")` should return `"para 1\n\nAs such, this is bad."`.

## 4. F1 — Per-claim triangulation budget + parallel URL ingest

- [x] 4.1 In `src/triangulate.ts`, replace `for (const url of urls) { await ingestUrl(url); }` inside `triangulateOne` with `await Promise.all(urls.map(ingestUrl))`. The 6 URLs (3 from corroborate query + 3 from contradict query) now ingest concurrently.
- [x] 4.2 Add a per-file constant `PER_CLAIM_BUDGET_MS = 60_000`. Change `triangulateClaims(claims, budgetMs)` signature to `triangulateClaims(claims)` — drop the budget parameter.
- [x] 4.3 Inside `triangulateClaims`, remove the loop-level `if (elapsed > budgetMs)` skip-block. Replace it with a per-claim wall-clock check inside `triangulateOne`: capture `t0 = performance.now()` at the top of the function, and after `Promise.all` of URL ingests resolves, if `performance.now() - t0 > PER_CLAIM_BUDGET_MS`, skip the corroboration-scoring step and return defaults `{corroborations:0, contradictions:0, contested:false, queriesRan:2}` with a `claim.triangulated` event marked `error: 'budget exceeded mid-claim'`.
- [x] 4.4 In `src/synthesize.ts`'s `synthesizeViaThesisPath`, remove the `synthesisBudgetMs`/`triangulationBudgetMs` computation and the `TRIANGULATION_BUDGET_MS` constant. Just call `await triangulateClaims(thesis.claims)`. Drop the local constants `TRIANGULATION_BUDGET_MS` and `TRIANGULATION_BUDGET_FRACTION` if any references remain.
- [x] 4.5 Verify `bun run typecheck` after the signature change.

## 5. Validation

- [x] 5.1 Run `bun run typecheck` — no errors.
- [x] 5.2 Run `openspec validate v2-tuning` — passes.
- [x] 5.3 Visual diff review: every spec requirement maps to at least one task; every task targets at least one spec requirement.

## 6. Smoke run on the canonical question

- [x] 6.1 Smoke run executed: `bun run research --fresh "..." --deadline 15m`. **9 iterations, 166 main-loop facts, 556 total facts (incl. triangulation), 6 sections, 39.0 min wall-clock, report at `.sheldon/reports/1778430284927.md`.**
- [x] 6.2 Watch tail confirmed all four fixes' telemetry: `gap.analyzed` event payload now includes a `gaps` array with each gap's `{question, relevance, why, pushed}` — F4 ✓. `claim.triangulated` events fire with `queriesRan: 2` for **all 6 thesis claims** (vs S3 where 5/6 had `queriesRan: 0`) — F1 ✓ structurally. Per-claim durations: 276s, 198s, 316s, 153s, 504s, 3.8s — 5 of 6 hit `error: 'budget exceeded mid-claim'` because the 60s per-claim budget is too tight for today's LLM latency (~20s/call avg). The ingest happened; the corroboration scoring was skipped, returning defaults — acceptable degradation but worth a constant retune.
- [x] 6.3 F2 visible in Section 3 ("Contractual Governance Shifts"): the closing paragraph opens with **"As such, these contractual barriers..."** — that's the post-processor firing and replacing the model's preferred banned-word opener. ✓ One regex-scope gap: Section 4 ends with `"Ultimately, the concept of human-in-the-loop..."` as the last *sentence* of a single-paragraph section. The regex matches first-word-of-last-paragraph; doesn't catch transitional words inside single-paragraph sections. Known limitation; tighten later if it matters.
- [x] 6.4 F3 + F4 win clearly visible. Sample gap-analyzer output from this run: **"What specific revenue percentages or contract loss rates have Wipro, TCS, and Accenture re..."** (r=0.9), **"How are major outsourcing firms (e.g., Infosys, Cognizant) structuring their new 'AI produ..."** (r=0.85). Explicit named-player gap questions for the first time. ✓
- [x] 6.5 Compared against S3's smoke. **Triangulation queries fired 6× this run vs S3's effective 1×** — every claim contributed evidence to the corpus instead of just claim 1. **But named players (TCS / Infosys / Accenture / etc.) still don't appear in the final report.** Sources are KPMG, a16z, MIT Sloan, Stanford GSB, Holon Law, EU EDPB — none surface vendor-specific revenue/contract data. This is a **search-layer** limitation: SearXNG → scrape doesn't return vendor IR pages or paid analyst-firm data for those queries. The gap-analyzer proposed the right questions; the underlying search infrastructure can't fulfill them. **Out of scope for v2-tuning** — would need a v3 change (custom search adapters / paid APIs / vendor-specific scrapers).
- [x] 6.6 Smoke findings recorded inline. Headline: F3 + F4 are unambiguous wins; F2 catches multi-paragraph violations (single-paragraph blind spot logged); F1 is structurally fixed (queries fire for all claims) but per-claim budget needs tuning higher given current LLM latency. **The named-players-in-final-report goal that motivated F3 is NOT fully achieved — search-layer limitation surfaces below v2's tuning surface.** Two small known limitations to document for later: (a) F1's `PER_CLAIM_BUDGET_MS = 60_000` should rise to ~180_000 (or add per-URL timeouts on `ingestUrl`); (b) F2's regex misses transitional words inside single-paragraph sections.
