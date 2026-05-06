# Tasks

## 1. Extend event taxonomy

- [x] 1.1 Add 8 new kinds to `EventKind` in `src/events.ts` (`frontier.seed/push/dedupe/pop/done/skip`, `iteration.start/end`)

## 2. Database schema

- [x] 2.1 Extend `src/db.ts` CREATE block with `frontier` table + index `idx_frontier_status_score`

## 3. Frontier queue module

- [x] 3.1 `src/frontier.ts` exporting `push`, `pop`, `markDone`, `markSkipped`, `listPending`, `listAll`, `count`, `allEmbeddings`
- [x] 3.2 `push`: brute-force max-cosine novelty check, dedupe at 0.85
- [x] 3.3 `pop`: transaction with `status='in-progress'` marker, ordered by score DESC then id ASC
- [x] 3.4 `markDone(id, outcome)` / `markSkipped(id, reason)` with proper events
- [x] 3.5 `listPending(limit=5)`: title-only rows, score DESC

## 4. Decomposer

- [x] 4.1 `src/decompose.ts` exporting `decomposer.decompose(task, opts?)`
- [x] 4.2 System prompt for breadth-first, scored seed questions
- [x] 4.3 JSON-schema responseFormat
- [x] 4.4 `llm.fast` with one retry; on persistent failure emit error event and return `[]`
- [x] 4.5 On success emit `frontier.seed` with task, seedCount, avgScore

## 5. Followup proposer

- [x] 5.1 `src/propose.ts` exporting `proposer.propose(ctx)`
- [x] 5.2 System prompt with grounding rules + skip-if-no-claims escape hatch
- [x] 5.3 Each claim truncated to 200 chars in prompt
- [x] 5.4 JSON-schema responseFormat
- [x] 5.5 `llm.fast` retry-once; on persistent failure return `[]`
- [x] 5.6 No event from proposer; caller closes iteration

## 6. Scorer

- [x] 6.1 `src/score.ts` with `score()` and `computeNovelty()`
- [x] 6.2 Linear combination: `0.5*relevance + 0.3*novelty + 0.2*(0.9^depth)`
- [x] 6.3 `computeNovelty`: dot product (vectors are L2-normalized), `1 - max`; empty → `1`

## 7. Refactor loop's indexer

- [x] 7.1 `indexSource` extracted from closure to exported helper, accepts optional `questionId`
- [x] 7.2 `searchLoop.answer(question)` continues to work unchanged

## 8. Research loop

- [x] 8.1 `src/research.ts` exporting `runResearch(task, opts)`
- [x] 8.2 Decompose → embed seeds → score → push to frontier
- [x] 8.3 Main loop: `iteration.start` → search/scrape/index → propose → push proposals → `iteration.end` + `markDone`
- [x] 8.4 Skip iteration on no-sources or zero-claims with appropriate `markSkipped` reason
- [x] 8.5 Returns ResearchSummary stats

## 9. CLI

- [x] 9.1 `src/run.ts` parses `--max-iters N`, `--seeds N`, positional task
- [x] 9.2 Prints task + config + final summary
- [x] 9.3 `bun run research` script wired

## 10. Inspect frontier

- [x] 10.1 `src/inspect.ts` accepts `--frontier` flag
- [x] 10.2 Sort: pending by score, then in-progress, then done by processed_at, then skipped

## 11. Smoke test

- [x] 11.1 `bun run typecheck` returns 0
- [x] 11.2 `bun run research "What are common pain points of using local LLMs?" --max-iters 3 --seeds 5` completed in 23m
- [x] 11.3 frontier=15 rows (3 done, 12 pending), all event kinds firing
- [x] 11.4 `bun run inspect --frontier` shows queue with mixed statuses, depths 0 and 1
- [x] 11.5 Event log shows full per-iteration cycle: frontier.seed → 5 frontier.push → (iteration.start → frontier.pop → search/scrape/extract/fact → iteration.end → frontier.done)×3
- [x] 11.6 No frontier dedupes this run (proposer output was distinct); fact dedupe rate 4.3% (29/644)

## 12. Validate, document, archive

- [x] 12.1 `openspec validate add-frontier-queue` passes
- [ ] 12.2 Update `README.md` Status line and layer index (L4 done)
- [ ] 12.3 Update `AGENTS.md` layer-status table (L4 done)
- [ ] 12.4 `openspec archive add-frontier-queue --yes`
- [ ] 12.5 Verify all new specs created and `event-log` updated
