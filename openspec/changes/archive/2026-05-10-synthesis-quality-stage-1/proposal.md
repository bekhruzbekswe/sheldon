# Proposal — synthesis-quality-stage-1

## Why

Two evaluation reports on the same question (`.sheldon/reports/1778049034961.md`, `.sheldon/reports/1778051386986.md`) revealed three structural failures in v1: irrelevant content reached the corpus and survived to the report (Google Cloud monitoring docs, generic latency alerting, generic AI privacy commentary all became sections of an *outsourcing* report); promotional sources (vendor marketing, single-blog over-reliance) were weighted identically with rigorous ones; and the section writer was *prompted* to produce transitional padding ("Furthermore… Consequently… Ultimately…") and slug-style headings. None of these required architectural change to fix — they required a relevance gate, a research-contract artifact, source-type metadata, a prompt rewrite, and a heading renderer. This change ships those five fixes as the first stage of the v2 quality plan documented in `docs/stages/`.

## What Changes

- **NEW** `research-contract` capability: at run-start, draft `{core_question, sub_questions, good_answer_contains, out_of_scope}` via one `llm.fast` call; embed and cache out-of-scope items; persist to `run_state.contract_json` (new column).
- **NEW** `source-classifier` capability: on first encounter of a domain, classify it (`source_type`, `promotional_intent`, `primary_vs_derivative`) via one `llm.fast` call; cache forever in a new `sources` table keyed by domain. Persists across `--fresh`. Labels only — does not drop sources.
- **MODIFIED** `fact-store`: `factStore.insert` now consults a cached task embedding (also new on `run_state`) and the contract's out-of-scope embeddings. Drops a fact when `cosine(fact, task) − max(cosine(fact, oos_i)) < T_drop`. Starting threshold `T_drop = 0.05` (intentionally permissive; tune from telemetry). Every drop emits the new `fact.dropped.irrelevant` event.
- **MODIFIED** `section-writer`: `SECTION_SYSTEM_PROMPT` rewritten — remove the "close with a one-sentence transition" instruction (root cause of trailing-padding); add explicit instructions to omit weakly-supported claims, hedge thin/single-source evidence, and avoid "Furthermore"/"Consequently"/"Ultimately" as section closers.
- **MODIFIED** `report-stitcher`: render section headings as Title Case with preserved initialisms (`AI`, `BPO`, `RAG`, `ROI`, `SLA`) instead of raw kebab-case slugs. Cluster labels stay kebab-case in storage; only the renderer un-slugifies.
- **MODIFIED** `run-state`: schema gains `contract_json TEXT` and `task_embedding BLOB` columns. `runStart()` writes them; `getRunState()` returns them. Resume reads them as-is — no recompute.
- **MODIFIED** `event-log`: `EventKind` extended with `fact.dropped.irrelevant`, `source.classified`, `contract.drafted`. `format.ts` gets matching cases.

Not breaking. Existing runs without the new columns work via `--fresh` (the standing convention — no migration system).

## Capabilities

### New Capabilities

- `research-contract`: drafting and persistence of the per-run research contract artifact (core question, sub-questions, good-answer signals, out-of-scope exclusions), plus task and out-of-scope embedding caches consulted by other capabilities.
- `source-classifier`: per-domain classification of scraped hosts (`source_type`, `promotional_intent`, `primary_vs_derivative`), cached in a `sources` table that persists across runs and `--fresh`.

### Modified Capabilities

- `fact-store`: insertion gains a relevance gate against the run's task and out-of-scope embeddings; new `fact.dropped.irrelevant` event signals dropped insertions.
- `section-writer`: prompt requirements change — remove transitional-padding instruction, add omit-weak / hedge-thin / banned-closer-words instructions.
- `report-stitcher`: section heading rendering changes from raw kebab-case to Title Case with preserved initialisms.
- `run-state`: row gains `contract_json` and `task_embedding` columns; `runStart`/`getRunState` round-trip them.
- `event-log`: `EventKind` union extended; `format.ts` formatter gains corresponding cases.
- `resume`: `clearAll()` switches from unlinking the SQLite file to per-table `DELETE` of the run-scoped tables (`facts`, `frontier`, `run_state`), preserving the new `sources` classifier cache across `--fresh`.

## Impact

**Code**: new modules `src/contract.ts`, `src/classify.ts`. Touched files: `src/db.ts` (schema), `src/events.ts` (EventKind), `src/format.ts` (formatter cases), `src/phase.ts` (`runStart` drafts contract + caches task embedding), `src/loop.ts` (`indexSource` classifies first-seen domain before extract), `src/facts.ts` (relevance gate), `src/sections.ts` (prompt rewrite), `src/synthesize.ts` (Title-Case heading renderer).

**APIs**: no external API surface — Sheldon is a single-process CLI. Internal interfaces extended only additively (new columns, new event kinds, new modules).

**Dependencies**: no new packages. The classifier and contract drafter use the existing `llm.fast` + JSON-schema + retry-once pattern from `extract.ts`/`propose.ts`/`decompose.ts`.

**Run-time cost**: contract drafting adds ~1 `llm.fast` call (~5–10s) at run-start. Source classification adds 1 `llm.fast` call per *first-seen* domain (~10–20 unique domains per run → ~1–2 minutes wall-clock; cached forever after). Relevance gate is two cosine sweeps per insert — cheap relative to existing per-insert dedupe scan.

**Risk**: relevance threshold (`T_drop = 0.05`) is an empirical guess; the first real run will need its `fact.dropped.irrelevant` log inspected and the threshold retuned. Mitigation: starting permissive and instrumenting every drop.

**Out of scope** (deferred to S2/S3 per `docs/stages/`): thesis-driven synthesis, per-claim section writing, triangulation, brutal-editor pass, gap analysis at phase boundaries, source-weighted scoring, domain-diversity penalty in the proposer, proposer fresh-bias fix.
