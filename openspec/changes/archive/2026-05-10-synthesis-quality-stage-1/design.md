# Design — synthesis-quality-stage-1

## Context

Sheldon v1 (L0–L8) ships a deadline-bounded research agent that gathers facts, clusters them, and writes a sectioned report. Two evaluation runs on the outsourcing-pain-points question (`.sheldon/reports/1778049034961.md`, `.sheldon/reports/1778051386986.md`) showed three structural quality gaps documented in `docs/stages/README.md` and broken into four stages in `docs/stages/`. This change is Stage 1 — the contained, low-risk slice that does not touch the cluster-driven synthesis architecture.

The five fixes (relevance gate, research contract, source classification, section-writer prompt rewrite, Title-Case headings) compose: the relevance gate uses the contract's out-of-scope items; the section writer's hedging instructions will eventually pair with source-classifier output; the heading renderer is independent and lives in the stitcher.

Constraints inherited from L0–L8:

- LLM is Qwen3.5-9B at 32k via llama.cpp; `llm.deep` is currently broken (thinking burns the output budget). Use `llm.fast` for everything.
- New structured-output LLM calls follow the existing `response_format: json_schema` + retry-once + markdown-fence-strip pattern from `extract.ts` / `propose.ts` / `decompose.ts`.
- New event kinds extend the closed `EventKind` union in `events.ts` (compile-time enforced).
- No migration system — schema bumps run with `--fresh`. Hardcoded thresholds live as per-file constants, not config.

## Goals / Non-Goals

**Goals:**
- Drop facts that are clearly irrelevant to the user's question before they pollute the corpus.
- Tag every scraped domain with type / promotional intent / primary-vs-derivative metadata that downstream stages can consume.
- Establish an explicit run-start contract artifact (core question, sub-questions, good-answer signals, out-of-scope) that future stages will read and revise.
- Eliminate the prompt-induced transitional padding ("Furthermore… Consequently… Ultimately…") in section bodies.
- Render section headings as readable Title Case instead of slug strings.
- Persist domain classifications across runs (including `--fresh`) so re-classification cost is paid once per domain forever.

**Non-Goals:**
- Replacing cluster-driven synthesis with thesis-driven synthesis (S2).
- Section writers receiving a *claim* instead of a fact cluster (S2).
- Triangulation of load-bearing claims (S2).
- Brutal-editor pass that drops entire sections (S2).
- Gap analysis at phase boundaries (S3).
- Source-weighted scoring or domain-diversity penalty in the scorer / proposer (S3).
- Frontier-side relevance gating (open question, deferred — see §Open Questions).

## Decisions

### D1. Source classification keyed by domain, not URL

**Choice:** the `sources` table's primary key is `domain` (e.g. `unity-connect.com`), not URL. On first encounter of a previously-unseen domain, run one classifier `llm.fast` call; cache the result forever.

**Alternatives:**
- *Per-URL classification* — fresh classification for every scraped page. Rejected: same-domain URLs almost always share `source_type` and `promotional_intent` (a vendor's blog post and their case-study page are both vendor marketing); per-URL classification 3–5x's cost without quality benefit.
- *Hand-curated domain list* — pre-populate a list of known-vendor / known-academic domains. Rejected: subjective, maintenance-heavy, and the user's brief explicitly disfavours it.

**Rationale:** quality is a property of the host, not the page. Per-domain caching is cheap (~10–20 unique domains per run, one-time cost), survives across runs, and produces consistent labels for the same source.

### D2. Persist `sources` across `--fresh`

**Choice:** `clearAll()` (in `resume.ts`) switches from "unlink the entire `sheldon.db` file" to "DELETE FROM the per-run tables (`facts`, `frontier`, `run_state`)" while preserving the `sources` table. `events.jsonl` and `last-summary.md` continue to be deleted.

**Alternatives:**
- *Move `sources` to a separate file* (`.sheldon/sources.db` or `.sheldon/sources.json`). Rejected: introduces a second persistence target the dashboard would need to track; adds cross-file consistency concerns; doesn't match the existing single-db convention.
- *Re-classify on every fresh run* — accept the loss of cache. Rejected: the user's stage doc explicitly calls out that classification cost should be paid once per domain forever; a second-run-on-same-question paying full classification cost again is a regression.

**Rationale:** `sources` is a cross-run cache, not run-state. The cleanest expression is "one db file, but the cache table outlives any individual run." Switching `clearAll()` from file-unlink to per-table DELETE also incidentally removes the `SQLITE_IOERR_VNODE` failure mode the dashboard handles today (the file no longer disappears under an open handle).

### D3. Relevance gate at fact insertion, with out-of-scope subtraction

**Choice:** `factStore.insert` consults the run's cached task embedding and out-of-scope embeddings (from the contract). Insertion is dropped when:
```
score = cosine(fact, task) − max_i(cosine(fact, oos_i))
score < T_drop      → drop, emit fact.dropped.irrelevant
```
Starting `T_drop = 0.05`. Embeddings already exist (facts carry per-claim embeddings via `loop.ts:75`); cost is two cosine sweeps over short fixed-size sets — negligible against the existing dedupe scan.

**Alternatives:**
- *Plain cosine-to-task gate (no OOS subtraction)*. Rejected: catches obviously off-topic content but misses semantically adjacent irrelevance — generic AI privacy commentary on an outsourcing question has high cosine to "AI" but low value to the user. The OOS subtraction is what catches that case.
- *Gate at chunk level in `loop.ts`* (before extraction). Rejected: chunks contain a mix of relevant and irrelevant claims; rejecting the whole chunk is too coarse. Per-claim gating preserves useful signal from mixed-content sources.
- *Gate at frontier.push too*. Deferred to open questions — keeping fact-level gate as the single S1 deletion point and observing telemetry first.

**Rationale:** the deletion lens explicitly requires at least one drop point per stage; this is S1's primary one. Permissive starting threshold + per-drop logging means we tune from real telemetry rather than guess.

### D4. Contract stored as JSON column on `run_state`

**Choice:** add `contract_json TEXT` and `task_embedding BLOB` columns to `run_state` (which already has the singleton-row constraint). `runStart` writes both; `getRunState` returns them. Out-of-scope embeddings are *not* persisted — they're recomputed on first lookup after run-start (or resume) and cached in-process.

**Alternatives:**
- *Separate `contract` table.* Rejected: contract is per-run, lifecycle-coupled to `run_state`; a separate table introduces consistency cleanup concerns (deleting the row when the run resets) for no gain.
- *Persist out-of-scope embeddings on `run_state` too.* Rejected: re-embedding ≤5 short strings takes one `embedder.embed` batched call (~100–200ms); cheaper than a serialization round-trip and avoids the BLOB-array shape question.
- *Store the task embedding in-memory only.* Rejected: resume reads the run from SQLite and must produce the same gate behaviour without re-running `runStart` — task embedding has to be on disk.

**Rationale:** contract is per-run singleton state, like the rest of `run_state`. JSON column is the smallest footprint that preserves resume semantics. Re-embedding OOS items on lookup is cheap enough that storing them isn't worth the complexity.

### D5. Section-writer prompt rewrite, no structural change

**Choice:** rewrite `SECTION_SYSTEM_PROMPT` in `sections.ts`. Specifically:
- Remove "Open with a one-sentence framing of the section's theme. Close with a one-sentence transition or summary." (the explicit padding instruction).
- Add: thesis sentence opens; ranked points; explicit acknowledgement of contradictions; if a claim is only weakly supported (fewer than 3 supporting facts or single-source), hedge or omit; do not use "Furthermore", "Consequently", or "Ultimately" as the *first word* of any closing paragraph.
- Keep structural inputs unchanged — section writer still receives `(label, facts[], originalTask)`. The thesis-driven inversion that changes inputs to `(claim, ranked-facts)` is S2.

**Alternatives:**
- *Two-pass writing* (draft, then polish). Rejected as out-of-scope — adds an LLM call per section without architectural change. Could be tried in S2 if S1's prompt rewrite isn't sufficient.

**Rationale:** the failures we observed are prompt-driven, not architecture-driven. The cheapest credible fix is the prompt fix.

### D6. Heading rendering: Title-Case in the stitcher

**Choice:** `synthesize.ts` (the stitcher) applies a de-slug + Title-Case + initialism-preservation transform when rendering `## ${label}`. Cluster labels stay kebab-case in storage so existing event payloads, dashboards, and the `topic_tag` column don't change shape.

Initialisms preserved (per-file constant): `AI`, `BPO`, `RAG`, `RAG`, `ROI`, `SLA`, `API`, `CSR`, `BOT`, `BOTT`, `IT`, `KPI`, `CRM`. Easy to extend.

**Alternatives:**
- *LLM-generated headings post-write* — call `llm.fast` per section after the body is written. Deferred to S2 because that's where headings should naturally come from a *claim*, not a cluster label.
- *Change cluster.ts to emit Title-Case directly.* Rejected: would change every consumer's expectations of `topic_tag` / cluster.label shape — broader blast radius for a cosmetic fix.

**Rationale:** cosmetic-only; the deepest correct fix needs S2. Title-Case in the stitcher is the cheap right answer for now.

### D7. Contract drafting: graceful degradation, never block run

**Choice:** if the contract drafter `llm.fast` call fails or returns malformed JSON after retry, store an empty contract (`out_of_scope = []`). The relevance gate degrades to plain `cosine(fact, task) ≥ T_drop` — still a real gate, just without the adjacent-irrelevance signal. Emit `contract.drafted` with an `error` payload so we notice in telemetry.

**Alternatives:**
- *Abort run on contract failure*. Rejected: violates the existing non-throwing degradation pattern (`extractor.extract` returns `[]`, `proposer.propose` returns `[]`, etc.). The contract is a quality enhancement; failing it should not destroy a run.

**Rationale:** matches the project-wide degradation contract.

### D8. Source classifier: same JSON-schema retry pattern

**Choice:** `classify.ts` uses the existing `llm.fast` + `responseFormat: json_schema` + retry-once + markdown-fence-strip pattern. On persistent failure it returns a default classification (`source_type: 'other'`, `promotional_intent: 'medium'`, `primary_vs_derivative: 'mixed'`) and still inserts a row so subsequent first-encounter cost isn't paid again. The `raw_label_json` column is `null` in the failure path.

**Rationale:** the user-facing risk of misclassification is low (downstream stages use these as soft signals, not gates). Caching the failure prevents repeated retry storms.

### D9. Domain extraction: from URL via `new URL(url).hostname`

**Choice:** strip `www.` prefix; lowercase. No further normalization (no eTLD+1 — `blog.acme.com` and `acme.com` count as different domains). Keep it simple; if cross-subdomain consolidation becomes a real problem, revisit in S3.

## Risks / Trade-offs

- **Risk:** `T_drop = 0.05` drops legitimate adjacent content. → **Mitigation:** start permissive; every drop is logged with claim text and similarity scores; first real run telemetry drives the retune. The permissiveness is intentional.
- **Risk:** Source classifier produces inconsistent labels between near-duplicate domains (`acme.com` vs `blog.acme.com`). → **Mitigation:** `domain` is the cache key, so once a label exists for a domain it's stable; cross-subdomain divergence is acceptable for v2.
- **Risk:** `--fresh` semantics change (no longer unlink the db file). → **Mitigation:** updated behaviour is a strict subset of old behaviour from the user's perspective (run state still wiped); the only observable difference is the `sources` cache surviving, which is the desired effect. Dashboard's `SQLITE_IOERR_VNODE` handling becomes vestigial but harmless.
- **Risk:** Contract drafting LLM call takes ~5–10s at run-start, delaying the first iteration. → **Mitigation:** trivial relative to a multi-hour run; emit `contract.drafted` so the dashboard can show the wait. Run continues if it fails (D7).
- **Risk:** Source classification calls block `indexSource` on first encounter (~5–10s per new domain). → **Mitigation:** parallelizable across the typical 3 sources per iteration if same-iteration sources are different domains; on a long run the amortized cost is small. Cached forever after.
- **Risk:** Out-of-scope embedding cache invalidation is in-process only — if a future stage adds contract revision (S3), the cache must be invalidated. → **Mitigation:** S3 will own that invalidation; for S1 the contract is immutable post-runStart.
- **Risk:** Relevance gate inadvertently kills early-run gathering before the corpus has any context. → **Mitigation:** gate fires per-fact, not per-source; even an iteration with mostly-dropped facts still emits `iteration.end` so the loop continues. Worst case is reduced fact volume on a poorly-scoped contract — recoverable.
- **Trade-off:** Title-Case heading rendering won't match the heading-from-content quality we'll get in S2. → **Acceptable:** the slug → Title-Case fix removes the cosmetic embarrassment; S2 fixes the heading-content mismatch separately.

## Migration Plan

This is a personal CLI tool with a single user; no live migration concerns.

The new `sources` table is created via `CREATE TABLE IF NOT EXISTS` in `getDb()` — automatic on first open. The two new `run_state` columns (`contract_json`, `task_embedding`) need to land on a pre-existing v1 schema as well; since `CREATE TABLE IF NOT EXISTS` is a no-op for existing tables, two idempotent `ALTER TABLE run_state ADD COLUMN` statements run after the create block (each wrapped in a swallow-on-existing try/catch — SQLite has no `ADD COLUMN IF NOT EXISTS`). This is the smallest possible deviation from the "no migration system" convention; it lets users with a v1 `.sheldon/sheldon.db` lying around upgrade without manual file deletion. Future stages with destructive schema changes should still rely on `--fresh`.

No rollback is needed beyond `git revert` and a single `--fresh`. The reworked `clearAll()` (D2) preserves the `sources` cache going forward, so cross-run classification cost is paid once per domain forever.

## Open Questions

- **Should the relevance gate also gate `frontier.push`?** Deferred — observe whether fact-side gating alone catches the off-topic seed-question case. If gap-of-irrelevant-questions stays large, S2 or S3 lifts the gate to the frontier.
- ~~**What's the right starting `T_drop`?** Guess at `0.05`.~~ **Resolved.** First-run telemetry (15-min smoke, 228 extracted, 212 dropped at `T_drop=0.05`) showed that score-distribution percentiles land in `[-0.14, +0.03]`. Both `taskSim` and `maxOosSim` naturally fall in 0.2–0.5 for MiniLM-L6, so their difference is small. Retuned to `T_drop = -0.10` for the second run; expected pass-rate ~75% of claims, with the genuinely-OOS bottom decile (score < -0.10, min observed -0.47) still rejected.
- **Is per-domain primary-vs-derivative reliable from a 24K-char Readability excerpt?** Probably noisy. Field is `null` on classifier failure; downstream consumers must tolerate that. S3 scoring should not over-rely on it.
- **Should contract revisions happen at phase boundaries, or only at run-start?** S3 owns this question. S1 ships only the run-start draft.
- **Dashboard impact?** `format.ts` gets new event-kind cases; the live SSE stream renders them. The dashboard UI doesn't currently surface `fact.dropped.irrelevant` separately from `fact.dedupe`; UI work is not in scope for S1.
