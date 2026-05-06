# Tasks

## 1. Extend event taxonomy

- [x] 1.1 Added `'cluster.computed' | 'section.written' | 'report.written'` to `EventKind`

## 2. Clustering module

- [x] 2.1 `src/cluster.ts` exporting `clusterFacts(facts, opts?)`
- [x] 2.2 K-means with cosine distance over L2-normalized embeddings
- [x] 2.3 k-means++ init via deterministic Mulberry32 seed; converges or stops at 50 iterations
- [x] 2.4 k sweep [kMin..kMax] with silhouette pick; small-N (<25) forces k=1
- [x] 2.5 Drops clusters < minSize, sorts surviving by size desc
- [x] 2.6 Labeling: dominant topicTag if >50%, else `llm.fast`-generated kebab-case label
- [x] 2.7 Emits `cluster.computed` with k, clusterCount, silhouette, sizes

## 3. Section / intro / outro writers

- [x] 3.1 `src/sections.ts` exporting `writeSection`, `writeIntro`, `writeOutro`
- [x] 3.2 Section system prompt: 200–500 words, [N] citations, no fabrication, note contradictions
- [x] 3.3 User message with `<fact id=N url=… title=…>` blocks
- [x] 3.4 **Switched to `llm.fast` for sections** — Qwen3.5 thinking burns the entire output budget on reasoning_content for 12-fact prompts, returning empty bodies. Fast mode produces reliable text in ~17s/section. (Documented in design.md as a v1 decision; deep-mode polish is a future layer.)
- [x] 3.5 Filter out [K] references where K ∉ 1..N; track `usedLocalIds`
- [x] 3.6 Two-attempt retry on empty body / network errors
- [x] 3.7 Compute wordCount + citationCount; emit `section.written`
- [x] 3.8 `writeIntro` and `writeOutro` use `llm.fast` with maxTokens 800/600

## 4. Report stitcher

- [x] 4.1 `stitchReport()` exported from `synthesize.ts`
- [x] 4.2 First-appearance global numbering; collapses duplicate URLs
- [x] 4.3 Renders H1 task, byline, intro, H2 sections + bodies, H2 Conclusion + outro, H2 Sources
- [x] 4.4 Pure function (no I/O)

## 5. Synthesize orchestrator

- [x] 5.1 `synthesize.ts` exporting `synthesize()`
- [x] 5.2 `factStore.listAllWithEmbeddings()` helper added
- [x] 5.3 Falls back to single "findings" cluster if clustering yields nothing
- [x] 5.4 Per-cluster: trim to 12 closest-to-centroid facts (Cloudflare 524 mitigation)
- [x] 5.5 Sequential section calls; intro/outro from labels only
- [x] 5.6 mkdir reports/, write `<runId>.md` and `latest.md`
- [x] 5.7 If runId.md exists, suffix `-v2`, `-v3`...
- [x] 5.8 Emit `report.written` with path, sectionCount, factCount, byteSize

## 6. Wire into research loop

- [x] 6.1 `runResearch` calls `synthesize()` after `runEnd` if phase reached synthesis and facts > 0
- [x] 6.2 Synthesis errors caught + logged; do not poison run summary
- [x] 6.3 `ResearchSummary` gains optional `reportPath`

## 7. CLI

- [x] 7.1 `src/synth.ts` standalone entrypoint; reads existing DB
- [x] 7.2 `bun run synthesize` script wired

## 8. Smoke test

- [x] 8.1 `bun run typecheck` clean
- [x] 8.2 `bun run synthesize` against existing 163-fact DB → success
- [x] 8.3 `.sheldon/reports/latest.md` (17.9 KB) contains H1 task, intro, 7 H2 sections, Conclusion, Sources
- [x] 8.4 Citations [1] [2] resolve to source bibliography; no orphaned `[N]` references
- [x] 8.5 Event log shows 1 `cluster.computed` (k=7), 7 `section.written` (300-340 words/12 cites each), 1 `report.written`
- [x] 8.6 Each section completed in ~17s using `llm.fast` (well under Cloudflare's 100s edge timeout)

## 9. Validate, document, archive

- [x] 9.1 `openspec validate add-synthesis` passes
- [ ] 9.2 Update `README.md` Status line and layer index (L6 done)
- [ ] 9.3 Update `AGENTS.md` layer-status table (L6 done)
- [ ] 9.4 `openspec archive add-synthesis --yes`
- [ ] 9.5 Verify all new specs created and `event-log` updated
