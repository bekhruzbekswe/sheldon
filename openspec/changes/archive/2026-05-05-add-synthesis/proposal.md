## Why

After L5 the agent stops searching at the synthesis trigger but produces nothing readable. It's just hundreds of atomic facts in a SQLite table. The user comes back from the gym to a database, not a report.

L6 turns the fact store into a written report. The constraint we've designed for since L0 is that no single LLM call can hold all the facts at once (32k context), so synthesis is **cluster → section-per-cluster → stitch**. The per-section LLM calls use `llm.deep` (thinking on) — these are the rare quality-critical calls of a multi-hour run.

Output is a single Markdown file at `.sheldon/reports/latest.md` (plus a stable run-id-stamped copy) with global `[N]` citations and a bibliography pointing back to source URLs.

## What Changes

- New `cluster-facts` module: k-means clustering over the 384-dim embeddings already stored in `facts.embedding`. Picks `k` via silhouette score across `[5, 10]`. Drops clusters with fewer than 5 members.
- New `section-writer` module: `llm.deep` prompt that writes a 200–500 word section for one cluster, citing facts with local `[1]`, `[2]`, `[3]` numbering relative to the cluster's facts.
- New `intro-writer` and `outro-writer` modules: shorter `llm.deep` prompts that get only section headings + the original task; produce framing text (intro paragraph, conclusion).
- New `report-stitcher`: re-numbers each section's local `[N]` to global `[N]` via a deterministic mapping, concatenates intro + sections + outro + sources block.
- New `synthesize()` orchestrator: pulls the run state, runs cluster → section-writers in sequence (sequential to keep llm-server load sensible) → stitcher. Writes `.sheldon/reports/<runId>.md` plus updates `.sheldon/reports/latest.md`.
- New `bun run synthesize` CLI for standalone runs against the existing fact DB. Useful for re-synthesizing a finished run with a new prompt or recovering from synthesis failure.
- Hook into `runResearch` so when the research loop exits in synthesis phase (and a fact store with content exists), `synthesize()` runs automatically before the process returns.
- New event kinds: `cluster.computed`, `section.written`, `report.written`.

Out of scope: HTML/PDF rendering, streaming the report, cross-section consistency passes, pushing to Telegram/email.

## Capabilities

### New Capabilities

- `cluster-facts`: K-means clustering of stored fact embeddings into 5–10 themes. Selects k via silhouette score, labels each cluster with its dominant `topic_tag` (or names it via LLM if no tag dominates), drops clusters smaller than `MIN_CLUSTER_SIZE` (default 5), returns ordered cluster array sorted by size descending.
- `section-writer`: LLM-driven (`llm.deep`) generator that writes a 200–500 word section for one cluster, citing facts with local 1-indexed numbering. System prompt forbids fabrication, encourages noting contradictions.
- `report-stitcher`: Pure function that takes intro + ordered sections + outro + cluster-to-fact mapping, renumbers each section's local citations to global ones, and emits the final Markdown body with a Sources bibliography. Preserves the local→global mapping in the returned object so callers can inspect which facts ended up where.

### Modified Capabilities

- `event-log`: extend `EventKind` with `'cluster.computed' | 'section.written' | 'report.written'`.

## Impact

- Code: new `src/cluster.ts`, `src/sections.ts`, `src/synthesize.ts`, `src/synth.ts` (CLI entrypoint). Modifies `src/events.ts`, `src/research.ts` (call synthesize on exit), `package.json` (`bun run synthesize` script).
- Dependencies: none — k-means is a few dozen lines of plain JS, and we already have embeddings.
- Storage: new directory `.sheldon/reports/` containing dated reports plus `latest.md`. SQLite tables untouched.
- Performance: synthesis adds N LLM `deep` calls (one per cluster, ≤10) plus 2 (intro + outro). Each call is ~10–30s. Total synthesis time ≈ 2–6 minutes for a typical run. Fits comfortably inside the 20% synthesis time budget for any deadline ≥ 30 min.
