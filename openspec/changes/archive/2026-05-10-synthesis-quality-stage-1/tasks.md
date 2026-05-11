# Tasks — synthesis-quality-stage-1

Implementation order: schema + events (no dependencies) → standalone modules (`contract.ts`, `classify.ts`) → wiring (`phase.ts`, `resume.ts`, `loop.ts`, `facts.ts`) → prompts/rendering (`sections.ts`, `synthesize.ts`) → validation + smoke.

## 1. Schema and event taxonomy

- [x] 1.1 Extend `EventKind` union in `src/events.ts` with `'fact.dropped.irrelevant'`, `'source.classified'`, `'contract.drafted'`. Verify `bun run typecheck` still passes.
- [x] 1.2 Add `CREATE TABLE IF NOT EXISTS sources (domain TEXT PRIMARY KEY, source_type TEXT, promotional_intent TEXT, primary_vs_derivative TEXT, classified_at INTEGER, raw_label_json TEXT)` to `getDb()` in `src/db.ts`.
- [x] 1.3 Add `contract_json TEXT` and `task_embedding BLOB` columns to the `run_state` `CREATE TABLE` in `src/db.ts`. (Schema-bumps assume `--fresh`; no migration is needed for existing dev DBs.)
- [x] 1.4 Add formatter cases for `fact.dropped.irrelevant`, `source.classified`, `contract.drafted` to `src/format.ts`. Each must produce a one-line summary mirroring the existing case style.

## 2. Research-contract module

- [x] 2.1 Create `src/contract.ts` exporting `ResearchContract = {core_question, sub_questions[], good_answer_contains[], out_of_scope[]}`, `draftContract(task)`, `getContract()`, `getTaskEmbedding()`, `getOutOfScopeEmbeddings()`.
- [x] 2.2 Implement `draftContract(task)` using `llm.fast` with `responseFormat: json_schema`, retry-once on parse failure, markdown-fence-strip fallback. Mirror the structured-call pattern from `src/extract.ts` / `src/propose.ts`.
- [x] 2.3 On contract drafter failure (post-retry parse failure or thrown error), return the empty contract `{core_question: task, sub_questions: [], good_answer_contains: [], out_of_scope: []}` so the run continues.
- [x] 2.4 Emit one `contract.drafted` event from `draftContract` with `layer: 'L5'`, `durationMs`, payload `{subQuestionCount, goodAnswerCount, outOfScopeCount}`. On failure, include an `error` payload field.
- [x] 2.5 Implement `getContract()` to read `run_state.contract_json` via `getDb()` and return the parsed object (or `null` if column is null / unparseable). Cache the parse result in-process; invalidate when run_state's `started_at` changes.
- [x] 2.6 Implement `getTaskEmbedding()` to decode the BLOB on `run_state.task_embedding` to a Float32Array(384). Cache in-process for the run.
- [x] 2.7 Implement `getOutOfScopeEmbeddings()`: lazy single batched `embedder.embed(contract.out_of_scope)` call on first invocation, cached in-process. Returns `[]` if `out_of_scope` is empty or contract is null.

## 3. Source-classifier module

- [x] 3.1 Create `src/classify.ts` exporting `SourceClassification = {sourceType, promotionalIntent, primaryVsDerivative}`, `extractDomain(url)`, `lookupSource(domain)`, `classifySource(domain, sampleText)`.
- [x] 3.2 Implement `extractDomain(url)`: `new URL(url).hostname.toLowerCase()`, then strip a leading `www.`. Returns the bare domain string.
- [x] 3.3 Implement `lookupSource(domain)` as a synchronous SQLite read of the `sources` table. Returns `null` if no row. Never invokes the LLM. Never mutates state.
- [x] 3.4 Implement `classifySource(domain, sampleText)` using `llm.fast` with `responseFormat: json_schema` (enum-restrict the three fields), retry-once, markdown-fence-strip fallback. Cap `sampleText` at the first 3000 characters of the scrape's text.
- [x] 3.5 On successful classification, INSERT a `sources` row with `classified_at = Date.now()` and the raw LLM JSON in `raw_label_json`.
- [x] 3.6 On persistent failure (post-retry malformed JSON or throw), still INSERT a row with default values `{source_type:'other', promotional_intent:'medium', primary_vs_derivative:'mixed'}` and `raw_label_json = NULL` to prevent retry storms on broken-classifier domains.
- [x] 3.7 Emit one `source.classified` event from `classifySource` with `layer: 'L3'`, `durationMs`, payload `{domain, sourceType, promotionalIntent, primaryVsDerivative}`. On failure include an `error` payload field.

## 4. Wire contract + task embedding into runStart

- [x] 4.1 In `src/phase.ts` `runStart`, after the `INSERT OR REPLACE INTO run_state` statement, call `embedder.embed([task])` and `UPDATE run_state SET task_embedding = ? WHERE id = 1` with the resulting Float32 little-endian buffer.
- [x] 4.2 In `src/phase.ts` `runStart`, after emitting `run.start`, call `await draftContract(task)` and `UPDATE run_state SET contract_json = ? WHERE id = 1` with `JSON.stringify(contract)`.
- [x] 4.3 In `src/phase.ts` `getRunState()`, extend the row decode to include `contract: ResearchContract | null` (parse `contract_json`) and `taskEmbedding: Float32Array | null` (decode the BLOB). Update the exported `RunState` type accordingly.
- [x] 4.4 Update any other callers of `getRunState()` whose object shape now has new optional fields. Search: `getRunState` across `src/`. Most callers only read existing fields; none should break with additive fields.
- [x] 4.5 Verify `run.start` event is emitted before `contract.drafted` (sequence in `events.jsonl`). The drafter runs after the row insert + run.start emit, before the runStart returns.

## 5. Modify resume.clearAll

- [x] 5.1 In `src/resume.ts`, change `clearAll()` from `unlink('.sheldon/sheldon.db')` (and WAL/SHM siblings) to `getDb()` then `db.exec("BEGIN; DELETE FROM facts; DELETE FROM frontier; DELETE FROM run_state; COMMIT;")`. The `sources` table is intentionally NOT deleted.
- [x] 5.2 Keep the existing `unlink('.sheldon/events.jsonl')` and `unlink('.sheldon/last-summary.md')` calls; both remain in scope of `clearAll()`. The `.sheldon/reports/` directory is still preserved.
- [x] 5.3 Update the inline JSDoc on `clearAll` in `src/resume.ts` to document the new behavior (per-table DELETE, preserves `sources`).
- [x] 5.4 Manually verify: after a `--fresh` run, `sources` rows from a prior run still appear in `bun run inspect --frontier` (or by direct SQLite query). And `facts`, `frontier`, `run_state` are empty. **Verified after second smoke run: `sources` table held 21 rows (10 from run-1 + 11 new from run-2), confirming the cross-run cache survived `--fresh`.**

## 6. Wire source classifier into indexSource

- [x] 6.1 In `src/loop.ts` `indexSource`, after the chunker but before per-chunk extract, call `extractDomain(source.url)` once per source.
- [x] 6.2 Call `lookupSource(domain)` synchronously. If it returns `null`, call `await classifySource(domain, source.text.slice(0, 3000))` once. Subsequent same-domain scrapes within the same run hit the populated cache.
- [x] 6.3 Confirm that classification of an already-known domain never invokes the LLM (assert via inspecting that no `source.classified` event fires for already-cached domains).

## 7. Implement the relevance gate in factStore.insert

- [x] 7.1 At the top of `src/facts.ts`, declare `const T_DROP = 0.05;` as a per-file constant.
- [x] 7.2 In `factStore.insert`, before the existing dedupe scan: lazily fetch `getTaskEmbedding()` and `getOutOfScopeEmbeddings()`. (If `task_embedding` is null on `run_state`, the gate is a no-op for that fact — record this as a defensive carve-out for tests / partial-state runs.)
- [x] 7.3 Compute `taskSim = cosine(input.embedding, taskEmb)` and `maxOosSim = max over oos embeddings (or 0 if none)`. Compute `score = taskSim - maxOosSim`.
- [x] 7.4 If `score < T_DROP`, emit one `fact.dropped.irrelevant` event with `layer: 'L3'`, payload `{claim: input.claim.slice(0, 80), sourceUrl: input.sourceUrl, taskSimilarity: Number(taskSim.toFixed(4)), maxOosSimilarity: Number(maxOosSim.toFixed(4)), score: Number(score.toFixed(4)), threshold: T_DROP}`. Return `null` immediately.
- [x] 7.5 Verify that the dedupe scan does not run for a dropped-by-relevance insert (event log should not contain a `fact.dedupe` event for that call).

## 8. Section-writer prompt rewrite

- [x] 8.1 In `src/sections.ts`, rewrite `SECTION_SYSTEM_PROMPT` per the spec: thesis-led opening, ranked points, explicit contradictions, hedge thin/single-source claims, omit weakly-supported claims, no closing transitional sentence, banned closer-words ("Furthermore", "Consequently", "Ultimately") as paragraph openers.
- [x] 8.2 Verify by inspection that the strings `"Open with a one-sentence framing"` and `"Close with a one-sentence transition"` no longer appear in `SECTION_SYSTEM_PROMPT`.
- [x] 8.3 Verify by inspection that the prompt explicitly mentions: a thesis sentence; "fewer than 3 supporting facts" or "single-source"; and the banned closer-words list.

## 9. Title-Case heading rendering

- [x] 9.1 In `src/synthesize.ts` (or a small helper module), add `INITIALISMS = new Set(['ai','bpo','rag','roi','sla','api','csr','bot','bott','it','kpi','crm'])` and `function renderHeading(slug: string): string` that splits on `-`, applies the rule (initialism → uppercase, else Title Case), joins with single space.
- [x] 9.2 In `stitchReport` (or `synthesize`'s callers of stitch), apply `renderHeading(section.label)` when emitting `## ${heading}`. Storage and event payloads continue to carry the original kebab-case label.
- [x] 9.3 Smoke-test via a unit example: `renderHeading('ai-patents-fuel-profit')` returns `'AI Patents Fuel Profit'`; `renderHeading('rag-privacy-and-ethics')` returns `'RAG Privacy And Ethics'`.

## 10. Validation

- [x] 10.1 Run `bun run typecheck` — no errors.
- [x] 10.2 Run `openspec validate synthesis-quality-stage-1` — passes (already verified during artifact authoring; rerun after task completion to re-validate against any spec edits).
- [x] 10.3 Visual diff review: every spec requirement maps to at least one task above; every task targets at least one spec requirement.

## 11. Smoke run on the canonical question

- [x] 11.1 `bun run research --fresh "What are the pain points of outsourcing companies in AI age?" --deadline 15m`. **Run 2 (T_DROP=-0.10): 9 iterations, 167 facts kept, 26 dropped, 5 sections, 13.8 KB report at `.sheldon/reports/1778407895016.md`, 13.5 min elapsed.**
- [x] 11.2 Tail `bun run watch` and confirm new event kinds appear. **Verified: `contract.drafted` × 1 at run start (success, 5 sub-questions / 7 good-answer / 5 OOS); `source.classified` × 11 first-seen domains; `fact.dropped.irrelevant` × 26 with full payload.**
- [x] 11.3 Inspect the resulting report; compare against A and B. **Mechanical wins all landed (Title-Case headings, no `Furthermore`/`Consequently`/`Ultimately` closers in section bodies, hedging ("Evidence is thin, but…") on thin-evidence claims). Substantive bar NOT met: report drifted into recruiting-tool / cloud-infra topics; missing-angle list (pricing collapse, GCC, named players, wage arbitrage, cannibalization) still missing despite the contract's `good_answer_contains` naming them. Diagnosis: corpus-acquisition problem, not S1's responsibility — S3 (gap analysis, source diversity, proposer fresh-bias fix) is the structural fix.**
- [x] 11.4 Sample dropped events. **At T_DROP=-0.10, dropped claims were either truly off-topic (recruiting-tool marketing with task-cosine 0.09–0.25 and oos-cosine 0.30–0.46) or borderline (data-sovereignty content adjacent but lower task signal). Tuning sound for current contract; S3's contract-revision pass at phase boundaries should further refine.**
- [x] 11.5 Smoke-run findings recorded inline in tasks 11.1–11.4 above and archived in this change. **Headline: 1 LLM-down false-start, then run 1 (T_DROP=0.05) over-rejected at 94%, retuned to T_DROP=-0.10 with telemetry, run 2 produced 5-section report with all S1 mechanical wins; substantive coverage of missed angles deferred to S3.**
