# Tasks

## 1. Dependency

- [x] 1.1 `bun add hono`

## 2. Server skeleton

- [x] 2.1 `src/server.ts` exporting `createApp()` returning a Hono instance
- [x] 2.2 `GET /health` returning `{ok:true}` for sanity
- [x] 2.3 `*` non-GET catch-all returns 405

## 3. Payload→summary formatter

- [x] 3.1 `src/format.ts` exports `formatEvent(event)` and `isErrorEvent(event)`
- [x] 3.2 Covers every `EventKind` (24 kinds)
- [x] 3.3 Examples verified at runtime: `frontier.push` → `q#999 "Test SSE delivery for the dashboard" · 0.85 · d1`

## 4. REST endpoints

- [x] 4.1 `GET /` reads `web/index.html` from disk and serves with `text/html`
- [x] 4.2 `GET /api/run-state` → run state + frontier counts; idle defaults when no row
- [x] 4.3 `GET /api/frontier` → all rows mapped to wire shape (no embeddings); per-row `factsAdded` from `facts.question_id` count
- [x] 4.4 `GET /api/facts?limit=N` clamped 1..100, default 20; site = URL hostname
- [x] 4.5 `GET /api/stats` returns `{factsCollected, dedupeRate, scrapeSuccess, llmTokens, sparks}` with 30 buckets per spark

## 5. SSE endpoint

- [x] 5.1 `GET /api/events` via Hono `streamSSE`
- [x] 5.2 Starts at current file size (no replay)
- [x] 5.3 250ms tail loop; reads new bytes, formats each line, emits SSE
- [x] 5.4 Skips malformed lines
- [x] 5.5 25s keepalive comment
- [x] 5.6 Honors client disconnect

## 6. Dashboard HTML

- [x] 6.1 `web/index.html` copied from design (1669 lines)
- [x] 6.2 Mock data declarations stripped (`RUN`, `FRONTIER`, `FACT_POOL`, `SAMPLE_EVENTS`, `ERR_EVENTS`)
- [x] 6.3 Mock `setInterval`s removed (`spawnEvent`, `spawnFact`, `advancePipeline` mock paths)
- [x] 6.4 `connectLive()` opens `EventSource('/api/events')` and feeds `pushEvent`
- [x] 6.5 `pollRunState`/`pollFrontier`/`pollFacts`/`pollStats` poll REST endpoints; in-flight guards prevent overlapping fetches
- [x] 6.6 `tickClock` reads `RUN.{startedAt,deadlineAt}` from polled state; `setPhase` only triggers on actual change
- [x] 6.7 `renderStats` consumes `state.sparks.{facts,dedupe,scrape,tokens}` directly
- [x] 6.8 Pipeline staircase advances by `KIND_FAM` of incoming events; values pulled from event summaries (search hits, scrape ratio, claim count, proposed count)
- [x] 6.9 Empty-state via `body.dataset.phase='idle'` handled by polled response

## 7. CLI

- [x] 7.1 `src/dashboard.ts` parses `--port N` (default 4000)
- [x] 7.2 Binds to `127.0.0.1`, prints URL to stderr
- [x] 7.3 `bun run dashboard` script wired in `package.json`
- [x] 7.4 SIGINT handled (server.stop + exit)

## 8. Smoke test

- [x] 8.1 `bun run typecheck` clean
- [x] 8.2 `bun run dashboard --port 4000` started; `curl /health` → 200 `{ok:true}`
- [x] 8.3 All endpoints returned correct shape against existing 169-fact DB:
  - `/api/run-state`: `phase=done, task=…, factsAdded=169, queue counts populated`
  - `/api/frontier`: 7 rows with `id, q, score, status, depth, parent, factsAdded`
  - `/api/facts?limit=2`: 2 most recent facts with `site` (hostname)
  - `/api/stats`: `factsCollected=169, dedupeRate=0.0287, scrapeSuccess=0.667, llmTokens=56705, sparks` 30-element arrays
- [x] 8.4 `GET /` returned 59KB HTML
- [x] 8.5 `POST /api/run-state` correctly returned 405
- [x] 8.6 SSE: appended a synthetic `frontier.push` line to events.jsonl mid-connection; client received `data: {…, summary: "q#999 \"Test SSE delivery for the dashboard\" · 0.85 · d1"}` within ~1s

## 9. Validate, document, archive

- [x] 9.1 `openspec validate add-dashboard` passes
- [ ] 9.2 Update `README.md` Status line + layer index
- [ ] 9.3 Update `AGENTS.md` layer-status table
- [ ] 9.4 `openspec archive add-dashboard --yes`
- [ ] 9.5 Verify both new specs exist in `openspec/specs/`
