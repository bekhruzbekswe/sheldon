# S1 — Relevance gate, research contract, source classification

> **Status: shipped 2026-05-10** (change `2026-05-10-synthesis-quality-stage-1` in `openspec/changes/archive/`).
> Empirical retune from telemetry: `T_DROP` started at `0.05` (rejected 94% of claims at first run), retuned to `-0.10` after inspecting score distributions. All other constants held.

## Why this stage exists

Three failure modes from reports A and B trace to the same root: nothing in the pipeline rejects content that isn't relevant to the original task, and nothing labels the *kind* of source a fact came from.

- **Off-topic sections passed unchallenged.** Report A's `big-tech-revenue-range` is entirely about Google Cloud API monitoring dashboards. Report A's `data-privacy-and-healthcare-efficiency` is generic p95/p99 latency alerting. Both have nothing to do with outsourcing pain points. They got included because retrieval found these sources and no relevance check rejected them. `facts.ts` only does cosine-≥-0.95 dedup against existing facts; nothing compares incoming claims to the task.
- **Promotional sources weighted identically with rigorous ones.** Report A's three CSR / labour / sustainability sections lean almost entirely on `unity-connect.com` (a BPO vendor's marketing page) and one LinkedIn pulse article. Report B's three BOT/BOTT sections lean on `aalpha.net` (a vendor blog). Vendor-on-its-own-industry has commercial interest in the framing — it's not neutral evidence. The pipeline has no way to know.
- **Slug-style headings surfaced as user-facing prose.** `ai-patents-fuel-profit`, `legacy-bpo-disruption-targets`, `difficult-subsume-claims-roi`. The cluster-labeller produces lowercase-hyphen-separated tokens (`cluster.ts:208-233`); the stitcher renders them raw as H2.
- **Transitional padding instructed by prompt.** `sections.ts:54` literally tells the writer: *"Open with a one-sentence framing of the section's theme. Close with a one-sentence transition or summary."* That instruction is the direct cause of every section ending in "Ultimately…" / "Consequently…".

## Goal

Make the agent capable of rejecting irrelevant content at insertion time, knowing the type and trustworthiness of every source it gathers, and producing readable section headings without padded prose. Without changing the cluster-driven synthesis architecture (that's S2).

## Hypotheses included

- **H2 — Relevance gate at fact insertion.** Embed the task once at run-start; on insert, drop facts whose `cosine(fact, task) − max(cosine(fact, out_of_scope_i))` is below a threshold. Out-of-scope items come from the contract (H12).
- **H7 — Human-readable headings.** Render section labels as Title Case (de-slugified) instead of raw kebab-case. Cheap fix for now; the proper solution (label after writing) lives in S2 alongside H1.
- **H8 — Section-writer prompt rewrite.** Remove "close with a one-sentence transition" — that's the explicit padding instruction. Add: thesis sentence, ranked points, omit weak/insufficiently-supported claims, hedge thin evidence explicitly, banned closer-words ("Furthermore" / "Consequently" / "Ultimately" as section closers). Hedging instruction is the small free addition the original handoff called out.
- **H9 — Source classification at scrape time.** Per-domain (not per-URL): on first encounter, one `llm.fast` call labels the host's `source_type`, `promotional_intent`, `primary_vs_derivative`. Cached forever in a new `sources` table keyed by domain. Persists across `--fresh`. Doesn't drop sources — just labels them so downstream stages can hedge or weight.
- **H12 — Research Contract at run-start.** Before `seedFrontier()`, one `llm.fast` call produces `{coreQuestion, subQuestions[], goodAnswerContains[], outOfScope[]}`. Stored as JSON on `run_state`. `outOfScope` items are embedded once and used by H2 as a rejection signal — catches semantically adjacent but irrelevant content (e.g., generic AI privacy commentary on an outsourcing question).

## Capabilities

### New

- `research-contract` — module that drafts and persists the contract artifact at run-start. Exposes `draftContract(task)`, `getContract()`, `getTaskEmbedding()`, `getOutOfScopeEmbeddings()`. Backed by JSON on `run_state`. One-time at run-start; lookup-only thereafter.
- `source-classifier` — module that classifies the *domain* of a scraped URL on first encounter and caches the result in a `sources` table. Lazy + persistent across runs. Exposes `lookupSource(domain)`, `classifySource(domain, sampleText)`. Doesn't decide whether to drop — only labels.

### Modified

- `fact-store` — `factStore.insert` consults the cached task embedding and out-of-scope embeddings. Drops on `cosine(fact, task) − max cosine(fact, oos_i) < T_drop`. New event `fact.dropped.irrelevant`.
- `section-writer` — `SECTION_SYSTEM_PROMPT` rewritten per H8 (above). No structural change; just prompt content.
- `report-stitcher` — render section headings as Title Case (de-slug + capitalise) instead of raw cluster labels.
- `run-state` — schema gains `contract_json TEXT` and `task_embedding BLOB` columns. `runStart()` writes them; `getRunState()` returns them. Resume reads them as-is — no recompute on resume.
- `event-log` — `EventKind` union extended with `fact.dropped.irrelevant`, `source.classified`, `contract.drafted`. `format.ts` gets matching cases for the watch CLI / dashboard summary.

## Dependencies

- All of L0–L8 already shipped.
- No prior stages required — this is the first stage.

## Key data structures / decisions

**Schema additions (in `db.ts`):**

```sql
CREATE TABLE IF NOT EXISTS sources (
  domain                 TEXT PRIMARY KEY,
  source_type            TEXT,    -- academic | regulator | analyst | vc-blog | trade-pub | vendor | personal-blog | forum | other
  promotional_intent     TEXT,    -- none | low | medium | high
  primary_vs_derivative  TEXT,    -- primary | derivative | mixed
  classified_at          INTEGER,
  raw_label_json         TEXT     -- full LLM response, in case we want fields later
);

ALTER TABLE run_state ADD COLUMN contract_json TEXT;
ALTER TABLE run_state ADD COLUMN task_embedding BLOB;
```

(No formal migration system — bump the schema and run with `--fresh`. Existing convention.)

**Contract shape (JSON-schema'd, lives in `run_state.contract_json`):**

```json
{
  "core_question": "string",
  "sub_questions": ["string", "..."],     // 3-5
  "good_answer_contains": ["string", "..."], // what would satisfy the user
  "out_of_scope": ["string", "..."]       // explicit exclusions, ≤5
}
```

`out_of_scope` items are embedded once at run-start and cached in the contract module. Each item must be specific enough to embed usefully (a phrase like "API monitoring dashboards" works; "irrelevant content" doesn't). The drafter prompt enforces concreteness.

**H2 relevance gate, exact form:**

```
score = cosine(fact_emb, task_emb) - max_i(cosine(fact_emb, oos_i_emb))
drop if score < T_drop
```

`T_drop` starts at **0.05** (intentionally permissive — log the dropped facts as `fact.dropped.irrelevant`, then tune from telemetry on the first real run). The gate runs before the dedupe scan in `factStore.insert`, so we don't waste an O(n) cosine sweep on facts we'd drop anyway.

**Source-classifier prompt budget:** ~300 input tokens (sample text capped) + ~50 output. One call per first-seen domain. Realistic run hits 10–20 unique domains → 10–20 extra `llm.fast` calls totalling ~1–2 minutes wall-clock. Acceptable. Cached forever — second-run cost is zero.

**Section-writer prompt** (H8 rewrite):
- Open: thesis sentence stating the section's claim.
- Body: ranked points; explicit acknowledgement of disputed/contradictory claims.
- If a claim has fewer than 3 supporting facts or only single-source support, hedge explicitly ("Evidence is thin, but…" / "One source argues…").
- If a claim is only weakly supported, **omit it** rather than paraphrase.
- No closing transitional sentence.
- Banned section-closer words: "Furthermore", "Consequently", "Ultimately" (as the *first word* of a closing paragraph — they can appear elsewhere).

**Heading rendering** (H7): in `synthesize.ts` / `report-stitcher`, `ai-patents-fuel-profit` → `AI Patents Fuel Profit`. De-slug, split on `-`, Title-Case each token, preserve known initialisms (`AI`, `BPO`, `RAG`, `ROI`, `SLA`, etc. — small per-file constant). Keep `cluster.ts` outputting kebab-case for storage; only the renderer un-slugifies.

**Out-of-scope embedding storage**: don't add a new column to `run_state`. Re-embed on first call after run start (or resume) and cache in-process. Cheap (≤5 short strings, one batched embedder call).

## Deletion lens

- **At fact insertion (H2)** — drops irrelevant facts before they pollute the corpus. ✓
- **At section writing (H8)** — the writer is now instructed to omit weakly-supported claims rather than paraphrase them. Soft drop, but real. ✓
- **At source classification (H9)** — labels only, no drop. The drop semantics arrive in S2/S3 (synthesis can refuse to use vendor-marketing-only sources for sections about that vendor's industry).

S1 introduces two real deletion points: the gate and the writer-omit instruction.

## Out of scope (deferred to later stages)

- **Thesis-driven synthesis** (H1, H6) — S2.
- **Brutal-editor pass and section-validation rubric** — S2.
- **Triangulation of load-bearing claims** (H11) — S2 (moved here from S3 because triangulation needs a thesis to know what's load-bearing).
- **Gap analysis at phase boundaries** (H4) — S3.
- **Source-weighted scoring + diversity penalty** (H10) — S3.
- **Proposer fresh-bias fix** (proposer reads `factStore.list({limit:8}, created_at DESC)`; should sample by task-relevance instead) — S3.
- **Working hypothesis across iterations** (H3) — S4.
- **Contract revision at phase boundaries** — S2 or S3 (one extra call per phase boundary). The initial contract is what ships in S1.
- **Per-claim embeddings vs per-chunk embeddings** — facts already carry their own embedding (computed from the claim text) per `loop.ts:75`. No change needed.

## Open questions

- **Is `T_drop = 0.05` the right starting threshold?** MiniLM-L6-v2 cosines for "outsourcing pain points" vs. clearly off-topic content (Google API monitoring) are likely 0.10–0.15; against legitimate adjacent content (BPO disruption analysis) likely 0.45–0.6. The task-minus-OOS form should give 0.05 enough headroom, but verify on the first real run by inspecting the `fact.dropped.irrelevant` log.
- **Can the source classifier reliably distinguish primary from derivative?** A vendor citing "Gartner says X" looks textually similar to Gartner itself in a Readability-extracted excerpt. Worst case the field is mostly `mixed`. Acceptable for S1; S3 scoring should not over-rely on it.
- **Should `out_of_scope` items also gate the frontier (not just facts)?** Probably yes, but defer until we see how often the gate alone catches things. One change at a time.
- **What if the contract draft fails or returns garbage?** Fall back to `out_of_scope = []` and the gate degrades to `cosine(fact, task) > T_drop`. Emit `contract.drafted` with `error` payload so we notice.

## Suggested openspec change name

`synthesis-quality-stage-1` *(scaffold already created at `openspec/changes/synthesis-quality-stage-1/` — schema spec-driven, no artifacts written yet)*.
