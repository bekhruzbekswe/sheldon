# v2 — tuning follow-ups

> **Status: shipped 2026-05-11** as a single bundled change `2026-05-11-v2-tuning` in `openspec/changes/archive/`. All four follow-ups (F1–F4) landed. Two small known limitations remain after the smoke run; documented at the bottom as candidates for a future tune *only if real-task usage shows they actually matter*.

This file originally tracked the four follow-ups as an open backlog. Kept here as historical context plus a record of what shipped and what's still loose.

---

## F1 — Triangulation per-claim budget + parallel URL ingest *(shipped)*

**What shipped:** `src/triangulate.ts` switched from a flat total `TRIANGULATION_BUDGET_MS` to per-claim `PER_CLAIM_BUDGET_MS` enforced inside `triangulateOne`. URL ingestion within a single claim runs via `Promise.all` instead of sequential `for…await`. The orchestrator no longer passes a budget into `triangulateClaims`.

**Smoke result:** all 6 thesis claims now get `queriesRan: 2` (vs S3's pre-fix run where only claim 1 fired its queries). Every claim contributes triangulation facts to the corpus.

**Empirical retune:** the constant started at `60_000` (60s). The smoke run showed 5 of 6 claims exceeded that budget — per-claim durations 153s / 198s / 276s / 316s / 504s / 3.8s on a slow-LLM day. Retuned to `180_000` (3 min) post-smoke. Catches typical-day cases; the 504s outlier can still trigger budget-exceeded but the ingest still happens — only the corroboration scoring is skipped.

## F2 — Banned-closer-words deterministic post-processor *(shipped)*

**What shipped:** `removeBannedClosers(body)` helper in `src/sections.ts`, applied inside both `writeSection` (cluster fallback) and `writeSectionFromClaim` (thesis path). Regex matches the first word of the last paragraph; rotates between `As such,` / `In sum,` / `That is,`.

**Smoke result:** verified firing in section 3 of the smoke report (closing paragraph rewritten from a banned word to `"As such,"`).

## F3 — Tighten gap-analyzer prompt with priority angles *(shipped)*

**What shipped:** extended `SYSTEM_PROMPT` in `src/gap.ts` with a `PRIORITY ANGLES` section listing named industry players, quantitative figures, time-bounded events, and `good_answer_contains` adjacencies. Phrased as opt-in ("consider when relevant"), not mandatory.

**Smoke result:** unambiguous win on the canonical question. The gap-analyzer now proposes named-player-specific questions like *"What specific revenue percentages or contract loss rates have **Wipro, TCS, and Accenture** reported…"* and *"How are major outsourcing firms (e.g., **Infosys, Cognizant**) structuring their new 'AI products'…"*. F4's payload made this visible — without F4 we'd only see counts.

## F4 — Log actual gap questions in `gap.analyzed` payload *(shipped)*

**What shipped:** extended the success-path event payload with `gaps: Array<{question, relevance, why, pushed}>`. Aggregate counts (`gapsProposed`/`gapsPushed`/`gapsDeduped`) are still in the payload for the one-line formatter summary. The full array is for `bun run inspect`-style deep diagnostics.

**Smoke result:** working as designed. Every `gap.analyzed` event in the smoke now shows the full proposed-questions list.

---

## What's still loose (candidates for future tunes)

These are small known limitations, not blockers. Documenting so they don't get forgotten if real-task usage surfaces them as actual quality problems.

### L1 — F1's budget doesn't bound individual URL slowness

The per-claim budget at 180s catches most cases on a typical day, but it's a *soft* post-hoc check: after `Promise.all` of URL ingests resolves, we check elapsed and skip corroboration scoring if over budget. **In-flight scrapes/extracts are NOT cancelled** — a single slow URL can still take 500+s if its scrape returns a long page with many chunks needing extraction. On slow-LLM days, this means some claims still hit `error: 'budget exceeded mid-claim'` and their corroboration counts default to `{0, 0, false}`.

**The real fix would be a per-URL timeout inside `ingestUrl`** (e.g., `AbortSignal` racing the chunk-extract pipeline against `setTimeout(45_000)`). 10–15 lines of code, bounds the slowest URL deterministically. Defer unless real-task reports show the defaulted-metadata path materially hurts section confidence calibration.

### L2 — F2's regex misses single-paragraph sections

The post-processor matches the first word of the *last paragraph*. When a section is a single paragraph that ends with a transitional sentence (e.g., `"...Ultimately, the concept of human-in-the-loop has emerged as a central principle"`), the regex doesn't fire because the banned word is mid-paragraph from its perspective.

Saw this in the smoke run on Section 4 ("The Hybrid Service Imperative"). The violation moved from "first word of closing paragraph" to "first word of last sentence in a single-paragraph section" — same vibe, different surface.

**The real fix would be broadening to first-word-of-last-sentence-in-closing-zone** (e.g., last 200 chars). Roughly: regex `(\n\n|[.!?]\s+)(Furthermore|Consequently|Ultimately)\b[,]?\s/` with a position check that the match occurs in the closing zone. ~5 lines of regex change. Defer unless single-paragraph violations recur visibly in real-task reports.

---

## What v2-tuning did NOT address (search-layer concern)

The smoke run revealed a deeper limitation that v2-tuning structurally can't fix: even when the gap-analyzer proposes the right questions (Wipro / TCS / Accenture revenue, Infosys / Cognizant AI products), the underlying SearXNG → scrape pipeline doesn't return vendor IR pages or paid analyst-firm content for those queries. Sources end up being aggregator blogs, KPMG / MIT Sloan / Stanford GSB content — solid, but absent named-player specifics.

This is a v3 concern (custom search adapters, vendor-specific scrapers, paid APIs like Crunchbase or PitchBook, or just running for much longer with multi-page search exploration). Out of scope for v2 in any form.

## Bundling closed

Suggested openspec change name when the bundle was picked up: `v2-tuning`. **Shipped 2026-05-11** as `archive/2026-05-11-v2-tuning`. No active follow-ups remain in this file.
