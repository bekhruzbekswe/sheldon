# Design — v2-tuning

## Context

S2 and S3 shipped 2026-05-10. Smoke-run telemetry surfaced four small standalone tunes — three quality issues and one diagnostic gap — documented in `docs/stages/v2-tuning-followups.md`. Each is self-contained, none depends on a future stage. This change ships them together as the natural bundle they form.

The four:
- **F1** — Triangulation budget bug. The current flat `TRIANGULATION_BUDGET_MS = 300_000` (5 min) gets eaten by claim 1 alone in practice (sequential URL ingestion of 6 URLs × scrape + per-chunk LLM extract = 3-5 min). Claims 2–N hit "budget exceeded" with `queriesRan = 0`.
- **F2** — Banned-closer-words enforcement. The section-writer prompt forbids `Furthermore` / `Consequently` / `Ultimately` as paragraph openers; the LLM treats it as soft, ~2 of 5 sections in real runs still violate.
- **F3** — Gap-analyzer prompt under-specifies what kinds of angles to surface. On the canonical question, the LLM didn't propose named-player-specific gaps (TCS, Infosys, Accenture, etc.) — the named-players bar gap from S3's smoke.
- **F4** — `gap.analyzed` event payload only carries counts; no way to see WHAT the LLM proposed. Diagnostic blind spot.

## Goals / Non-Goals

**Goals:**

- Get all 4–7 thesis claims actually triangulated, not just the first one.
- Eliminate banned-closer-word violations in shipped section bodies.
- Make the gap-analyzer surface named-player-specific angles when the task's industry has named players.
- Make `gap.analyzed` events self-explanatory in telemetry.

**Non-Goals:**

- S4 (living hypothesis).
- A scorer-level domain-saturation penalty (the S3-doc's deferred follow-up — wait for evidence proposer-level bias is too soft).
- Two-pass synthesis (the section-writer's "Future quality enhancements" list — orthogonal).
- A streaming variant of `LlmClient.dispatch` (would re-enable `llm.deep` but requires real engineering — out of scope).

## Decisions

### D1. Per-claim triangulation budget (F1)

**Choice:** in `src/triangulate.ts`, replace the flat `TRIANGULATION_BUDGET_MS` (passed by the orchestrator) with a per-claim wall-clock budget `PER_CLAIM_BUDGET_MS = 60_000` (60s) enforced inside `triangulateOne`. The orchestrator no longer computes a global budget at all — it just calls `triangulateClaims(claims)`. Total triangulation wall-clock is now bounded by `claims.length * PER_CLAIM_BUDGET_MS` ≈ 4-7 min for typical thesis sizes.

Per-claim enforcement: in `triangulateOne`, capture `t0 = performance.now()` and after the searches+ingestion steps, check elapsed against `PER_CLAIM_BUDGET_MS`. The check happens at natural awaiting boundaries (after `Promise.all` of URL ingests). When a single URL ingestion is slow enough to push past 60s, the claim still completes (we don't kill mid-ingest), but the next claim starts at its own `t0=0`.

**Alternatives:**

- *Total-budget-with-cap-and-divide.* Keep a total budget, divide by claim count for per-claim slice. Rejected: equivalent in steady state, more complex on edge cases (claim 1 finishes early; should claims 2-N get the leftover? Probably yes, but adds plumbing).
- *Hard kill mid-ingest at 60s.* Rejected: cancelling an in-flight scrape/extract leaves orphaned work and pollutes the corpus. Accepting that a claim might run 60-90s is fine.

**Rationale:** the bug was not "budget too small"; it was "one claim spent the whole shared budget". Per-claim is the structurally correct shape.

### D2. Parallel URL ingestion within a single claim (F1, second piece)

**Choice:** in `src/triangulate.ts`, replace the sequential `for (const url of urls) { await ingestUrl(url); }` inside `triangulateOne` with `await Promise.all(urls.map(ingestUrl))`. Each `ingestUrl` does scrape + chunk + extract + insert, and these run concurrently across the 6 URLs returned by the two SearXNG queries.

**Alternatives:**

- *Limit concurrency to N=2 or 3 with `pLimit`-style helper.* Rejected as premature: SearXNG, the LLM endpoint, and SQLite all serialize independently at their own layers. 6-way Promise.all is bounded by the slowest of those constraints; adding a custom concurrency limit doesn't help the bottleneck.
- *Stay sequential to keep dedupe-scan state clean.* Rejected: occasional near-duplicate inserts are acceptable for triangulation. SQLite serializes writes at the driver level; the dedupe scan reads whatever's committed when it runs.

**Rationale:** sequential ingestion was the dominant time sink. Parallel ingestion ≈ 5-10x speedup per claim with no correctness loss for this use case.

### D3. Banned-closer-words deterministic post-processor (F2)

**Choice:** in `src/sections.ts`, add a small `removeBannedClosers(body: string): string` helper:

1. Split `body` on `\n\n` (paragraph boundaries).
2. If the **last** paragraph's first word matches `/^(Furthermore|Consequently|Ultimately)\b[,]?\s/`, replace just that opening word with a rotating neutral connector (`As such,` / `In sum,` / `That is,`). The rotation index is driven by a per-call counter (or a hash of the body) — purely cosmetic.
3. Other paragraphs are not touched (mid-body uses of these words are allowed by the original rule).
4. Apply the helper inside both `writeSection` and `writeSectionFromClaim` immediately after `body = filteredBody;` (post-citation-filtering).

**Alternatives:**

- *Send a one-shot corrective LLM call when a banned closer is detected.* Rejected: extra ~5-10s per offending section per run. The lightweight regex rewrite is free.
- *Sample the rotation deterministically based on section index in the report.* Considered. Useful for reproducible reports. Implement if it matters; otherwise random rotation is fine.
- *Strip the offending word entirely (without replacement).* Rejected: leaves the sentence ungrammatical ("..., the lack of a stable pricing mechanism threatens the viability...").

**Rationale:** the prompt rule was correct; the model just doesn't always obey it. Deterministic post-processing closes the gap with zero LLM cost.

### D4. Gap-analyzer prompt extension with priority-angles guidance (F3)

**Choice:** in `src/gap.ts`'s `SYSTEM_PROMPT`, add a `PRIORITY ANGLES` section instructing the LLM to consider, when relevant to the task:

- Specific named industry players relevant to the task's industry, with concrete questions about their actual responses, revenue impact, or strategic shifts.
- Specific quantitative figures from named companies / regulators / analyst firms.
- Concrete time-bounded events (e.g., "since the EU AI Act took effect…").
- Adjacencies the contract's `good_answer_contains` items name but the corpus doesn't yet contain.

The phrasing is `consider when relevant`, NOT `must include`. For research tasks with no obvious named players (e.g., a question about a scientific concept), the LLM should still produce useful gaps without forcing the named-player frame.

**Alternatives:**

- *Hard requirement to include at least one named-player gap.* Rejected: over-steers for tasks where named players don't apply (e.g., "What is the current state of LLM grokking research?").
- *Inject named players as a separate filter pass.* Rejected: complexity not warranted; one prompt change is sharper.

**Rationale:** S3 left this gap intentionally; prompt-level fix is the natural close.

### D5. Per-gap question logging in `gap.analyzed` payload (F4)

**Choice:** in `src/gap.ts`'s `analyzeGaps` function, extend the success-path event payload with:

```ts
gaps: Array<{
  question: string,
  relevance: number,
  why: string,
  pushed: boolean,                  // false if frontier dedupe rejected it
  dedupedAgainstId?: number,        // when pushed=false, the matched-existing frontier id
}>
```

The existing aggregate counts (`gapsProposed`, `gapsPushed`, `gapsDeduped`) stay — the formatter consumes them for the one-line summary. The `gaps` array is for `bun run inspect`-style deep diagnostics and for telling whether F3's prompt change actually moved the LLM's output.

**Alternatives:**

- *Persist gap questions to a new `gap_log` SQLite table.* Rejected: events.jsonl is the right place. Schema bumps for telemetry only are anti-pattern (per the project's "no migration system" convention).
- *Include the gap text in the formatter line.* Rejected: would blow past the one-line constraint and clutter the dashboard. Inspect tools (or `jq` over events.jsonl) are the right surface.

**Rationale:** smallest possible diagnostic improvement; payload size grows ~500 bytes per `gap.analyzed` event, ≤2 events per run.

## Risks / Trade-offs

- **Risk:** F1's parallel ingestion produces near-duplicate fact rows when two scrapes from the same triangulation batch return overlapping content. → **Mitigation:** dedupe scan still runs per-insert; pairs that arrive within the same 50ms window may both pass dedupe (each sees the other not-yet-committed). Acceptable for triangulation; the per-claim retrieval at synthesis time picks ranked-best, so a duplicate fact gets demoted. Worst case: one stray duplicate in a section's evidence list.
- **Risk:** F2's regex rewrite produces a stylistic mismatch — `As such, the lack of a stable pricing mechanism…` may read worse than the LLM's preferred opener. → **Acceptable.** "No padding closer" beats "smooth padding closer". If the rewritten lines feel jarring on real reports, upgrade to D3's rejected alternative (one corrective LLM call per offending section).
- **Risk:** F3 over-steers — for a task where named players don't apply, the LLM may force them and produce poor gaps. → **Mitigation:** phrasing is "consider when relevant"; the rule is opt-in, not mandatory. First real-task usage on a non-named-player question will tell.
- **Risk:** F4's payload extension grows event-log file size noticeably over many runs. → **Acceptable.** Each run's `gap.analyzed` events are ≤2; 500 bytes × 2 = 1 KB per run. Negligible vs the existing log volume.
- **Trade-off:** None of F1-F4 are tested against a real-task report (only the canonical outsourcing question). They could ship and not move the bar on a different question. → **Acceptable.** Each is small, reversible, and individually defensible.

## Migration Plan

No DB schema changes. No new tables, no new columns. Roll-forward: drop the new code in. Rollback: `git revert`.

## Open Questions

- **What's the right `PER_CLAIM_BUDGET_MS`?** 60s is a starting guess. If first-run triangulation still produces budget-exceeded events for some claims, raise to 90s.
- **Should F2's neutral-connector rotation be deterministic (e.g., based on section index)?** First run will tell; if reports feel patterned, switch to deterministic. If they feel natural, keep random.
- **Is F3's prompt extension long enough to actually steer the LLM, or does it need to be more emphatic?** Empirical. Telemetry from F4 will reveal whether the LLM proposes named-player gaps.
- **Should `gap.analyzed` payload also log the slice that was fed to the analyzer?** Tempting for diagnostics but doubles the payload size; defer.
