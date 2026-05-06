# Tasks

## 1. Dependencies

- [x] 1.1 `bun add @xenova/transformers` (SQLite via built-in `bun:sqlite`, no extra dep)
- [x] 1.2 ~~`bun add -d @types/better-sqlite3`~~ — N/A; using `bun:sqlite`

## 2. Extend event taxonomy and llm-client

- [x] 2.1 In `src/events.ts`, add `'chunk.split' | 'embed.batch' | 'claim.extract' | 'fact.write' | 'fact.dedupe'` to `EventKind`
- [x] 2.2 In `src/llm.ts`, add an optional `responseFormat` field to `LlmCallOptions`; pass through to the request body when set, omit otherwise

## 3. Embedder

- [x] 3.1 Create `src/embed.ts` exporting `embedder.embed(texts)`
- [x] 3.2 Lazy-load `pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2')` on first call; cache the resulting pipeline
- [x] 3.3 Loop in batches of ≤32; for each batch call the pipeline with `pooling: 'mean', normalize: true` and unpack into `Float32Array(384)`s
- [x] 3.4 Emit one `embed.batch` event per batch with durationMs and count
- [x] 3.5 Also export `embedder.tokenize(text)` returning a token-id array (used by chunker)

## 4. Chunker

- [x] 4.1 Create `src/chunker.ts` exporting `chunkText(text, opts?)` returning `{text, tokenCount}[]`
- [x] 4.2 Use the embedder's tokenizer (`embedder.tokenize`) for token counting
- [x] 4.3 Splitting strategy: paragraph-first; pack into windows of `maxTokens` with `overlapTokens` overlap
- [x] 4.4 Fallback for paragraphs > maxTokens: split on sentence boundaries
- [x] 4.5 Last-resort fallback: hard-cut on token boundary
- [x] 4.6 Emit one `chunk.split` event per call with `inputChars`, `chunkCount`, `totalTokens`, optional `url`

## 5. Database layer

- [x] 5.1 Create `src/db.ts` exporting a singleton `getDb()` opening `.sheldon/sheldon.db`; `PRAGMA journal_mode=WAL`, `foreign_keys=ON`
- [x] 5.2 Idempotent `CREATE TABLE IF NOT EXISTS facts (...)` plus the two indexes (source_url, topic_tag)

## 6. Fact store

- [x] 6.1 Create `src/facts.ts` exporting `factStore.insert(...)`, `findSimilar(...)`, `list(...)`, `count()`
- [x] 6.2 Helpers: `floatArrToBuf`, `bufToFloatArr`
- [x] 6.3 Helper: `cosine(a, b)` (dot product since both are L2-normalized)
- [x] 6.4 `insert` dedupes against existing rows at cosine ≥ 0.95; emits `fact.dedupe` and returns null on hit
- [x] 6.5 `findSimilar` brute-force cosine, top-K with minSim
- [x] 6.6 `list` with optional WHERE source_url / topic_tag, ORDER BY created_at DESC LIMIT, embeddings excluded

## 7. Claim extractor

- [x] 7.1 Create `src/extract.ts` exporting `extractor.extract(chunk, ctx)`
- [x] 7.2 System prompt forbidding fabrication; user message with chunk + question
- [x] 7.3 Define JSON-schema `responseFormat` with `claims: [{text, confidence, topicTag}]`
- [x] 7.4 Call `llm.fast(messages, {responseFormat})`
- [x] 7.5 Parse + validate; retry once on malformed; emit `claim.extract` with error and return `[]` on persistent failure
- [x] 7.6 Emit `claim.extract` with claimCount, avgConfidence, sourceUrl

## 8. Wire into search loop

- [x] 8.1 In `src/loop.ts`, add `indexSource(scraped, question)` running in parallel across surviving sources
- [x] 8.2 chunk → extract claims → embed each claim → factStore.insert
- [x] 8.3 Source-level errors do not abort the loop (logged, source skipped)

## 9. Inspect CLI

- [x] 9.1 Create `src/inspect.ts` reading flags `--limit N`, `--topic X`, `--source URL`
- [x] 9.2 Print id, confidence (color by tier), topic tag, claim (truncated), source URL
- [x] 9.3 Wire `bun run inspect` script in `package.json`

## 10. Smoke test

- [x] 10.1 `bun run typecheck` returns 0
- [x] 10.2 `rm -rf .sheldon && bun run ask "What is the EU AI Act?"` completes
- [x] 10.3 `.sheldon/sheldon.db` exists; 147 facts written
- [x] 10.4 Event log shows full chain: search.query → scrape.fetch → chunk.split → embed.batch → claim.extract → fact.write/dedupe → llm.fast → summary.write
- [x] 10.5 `bun run inspect --limit 8` prints recent facts with confidence and topic
- [x] 10.6 8 fact.dedupe events fired during the run, confirming dedupe works

## 11. Validate, document, archive

- [x] 11.1 `openspec validate add-fact-store` passes
- [ ] 11.2 Update `README.md` Status line and layer index (L3 done)
- [ ] 11.3 Update `AGENTS.md` layer-status table (L3 done)
- [ ] 11.4 `openspec archive add-fact-store --yes`
- [ ] 11.5 Verify all new specs created and updated specs reflect the modifications
