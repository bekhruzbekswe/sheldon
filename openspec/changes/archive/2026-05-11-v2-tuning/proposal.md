# Proposal — v2-tuning

## Why

Four small follow-ups surfaced from S2/S3 smoke-run telemetry are documented in `docs/stages/v2-tuning-followups.md`. None depends on a future stage; each is self-contained. Bundling them into a single change closes the named-players gap that S3's machinery enabled but didn't fully exploit, fixes the triangulation budget bug that lets only one thesis claim get triangulated, and eliminates the visible banned-closer-words violations in section bodies.

## What Changes

- **MODIFIED** `claim-triangulator` (F1): switch `triangulateClaims` from a flat total-wall-clock budget to a **per-claim budget** (`PER_CLAIM_BUDGET_MS = 60_000`). Within a single claim's triangulation, run URL ingestion via `Promise.all` instead of sequential `for…await`. Per-claim budget enforced inside `triangulateOne`. The existing flat `TRIANGULATION_BUDGET_MS` is removed; total wall-clock is now bounded by `claims.length * PER_CLAIM_BUDGET_MS`.
- **MODIFIED** `section-writer` (F2): add a deterministic post-processor `removeBannedClosers(body)` that runs on the body returned from `writeSection` AND `writeSectionFromClaim` (both the cluster-fallback and thesis paths). When the **last paragraph's** first word is `Furthermore` / `Consequently` / `Ultimately`, regex-rewrite that first word to a neutral connector (rotating between `As such,` / `In sum,` / `That is,`). No additional LLM call.
- **MODIFIED** `gap-analyzer` (F3): extend `SYSTEM_PROMPT` in `src/gap.ts` with an explicit "Priority angles to consider" list — named industry players in the relevant industry; specific quantitative figures from named companies / regulators / analyst firms; concrete time-bounded events; adjacencies the contract's `good_answer_contains` items mention but the corpus doesn't yet contain. Phrased as "consider when relevant" not "must include" so it doesn't over-steer for tasks where named players don't apply.
- **MODIFIED** `gap-analyzer` (F4): extend the `gap.analyzed` event payload to include `gaps: Array<{question, relevance, why, pushed, dedupedAgainstId?}>` — the actual proposed questions and per-gap dispositions, not just counts. Diagnostic improvement; lets us see WHAT the LLM proposed at each phase boundary, not just HOW MANY. The formatter case in `format.ts` continues to show the count summary on one line; the full per-gap list is for `bun run inspect`-style diagnostics.

Not BREAKING. The `gap.analyzed` payload extension is additive (existing readers ignore the new field). The `claim-triangulator` budget shape changes but the function signature is preserved.

## Capabilities

### Modified Capabilities

- `claim-triangulator`: per-claim budget replaces total budget; URL ingestion within a claim runs in parallel.
- `section-writer`: post-processor runs on every returned body; regex-rewrites banned closer-words.
- `gap-analyzer`: prompt gains explicit priority-angles guidance (F3); event payload gains the actual gap-question list (F4).

### New Capabilities

None.

## Impact

**Code**: touched files — `src/triangulate.ts` (per-claim budget + parallel ingestion), `src/sections.ts` (`removeBannedClosers` helper applied to both writeSection variants), `src/gap.ts` (prompt extension + payload extension). No new modules.

**APIs**: no external surface. Internal signatures unchanged. Event payload for `gap.analyzed` gains an additive field — backwards-compatible for all existing consumers.

**Run-time cost**: F1 makes triangulation faster (URL ingestion parallel). F2 is zero-LLM, regex-only. F3 is a prompt change, no extra cost. F4 adds a few hundred bytes per `gap.analyzed` event payload — negligible. Net: triangulation completes faster, total run wall-clock should drop slightly.

**Risk**: F1's parallel ingestion means concurrent SQLite inserts. `bun:sqlite` serializes writes at the driver layer; concurrent dedupe scans can produce occasional near-duplicate inserts, acceptable for triangulation use case. F2's regex-rewrite may produce stylistic seams where the new connector mismatches the surrounding prose — acceptable; "no padding closer" beats "smooth padding closer". F3's prompt over-steers toward named-player questions for tasks where named players don't apply — mitigated by phrasing as "consider when relevant".

**Out of scope**: S4 (living hypothesis). Anything that requires more architectural change. The S3-doc's sketch of "scorer-level domain saturation penalty" if proposer-level diversity bias proves too soft — defer until there's evidence it's needed.
