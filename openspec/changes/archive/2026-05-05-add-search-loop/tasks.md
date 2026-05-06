# Tasks

## 1. Pre-flight

- [x] 1.1 Start SearXNG: `cd /Users/bekhruzbekmirzaliev/Lab/local-research-agent && docker compose up -d searxng`
- [x] 1.2 Verify reachable: `curl -sS "http://127.0.0.1:8888/search?q=hello&format=json"`
- [x] 1.3 Add `SEARXNG_BASE_URL=http://localhost:8888` to `.env.example` and `.env`

## 2. Dependencies

- [x] 2.1 `bun add jsdom @mozilla/readability`
- [x] 2.2 `bun add -d @types/jsdom`

## 3. Extend event taxonomy

- [x] 3.1 In `src/events.ts`, add `'search.query' | 'scrape.fetch' | 'scrape.skip' | 'summary.write'` to `EventKind`

## 4. SearXNG client

- [x] 4.1 Create `src/search.ts` exporting `searxngClient.query(text, opts?)`
- [x] 4.2 GET `/search?q=...&format=json&categories=general` with `User-Agent: Mozilla/5.0` and 10s `AbortController` timeout
- [x] 4.3 Parse JSON, return `{title, url, snippet}[]` from `data.results`
- [x] 4.4 Empty query throws Error with "empty query"
- [x] 4.5 Emit `search.query` event with durationMs, query (≤80), resultCount, topUrl (or error)

## 5. Web scraper

- [x] 5.1 Create `src/scrape.ts` exporting `scraper.fetch(url)`
- [x] 5.2 GET with `User-Agent: Mozilla/5.0`, 15s timeout
- [x] 5.3 Skip+log if Content-Type is not `text/html*` or status is non-2xx
- [x] 5.4 Parse HTML with `jsdom`, run `Readability` from `@mozilla/readability`
- [x] 5.5 If Readability returns null/empty, return null and emit `scrape.skip` with reason "readability"
- [x] 5.6 Truncate `text` to 24000 chars; set `truncated: true` if cut
- [x] 5.7 On success emit `scrape.fetch` with url, title (≤80), charCount, durationMs
- [x] 5.8 Wrap network errors so the function never throws — always returns null on failure

## 6. Search-loop orchestrator

- [x] 6.1 Create `src/loop.ts` exporting `searchLoop.answer(question)`
- [x] 6.2 Call `searxngClient.query(question)`; take top 3 URLs
- [x] 6.3 `Promise.all` `scraper.fetch(url)` for each; filter out nulls
- [x] 6.4 If 0 sources survive, throw "no usable sources"
- [x] 6.5 Build messages with system prompt + numbered `<result>` blocks
- [x] 6.6 Call `llm.fast(messages)`; capture `content`
- [x] 6.7 Write content to `.sheldon/last-summary.md`; emit `summary.write`
- [x] 6.8 Return content

## 7. ask CLI

- [x] 7.1 Create `src/ask.ts` reading `process.argv.slice(2).join(' ')`
- [x] 7.2 If empty: print usage and exit 1
- [x] 7.3 Call `searchLoop.answer(question)`, print result, exit 0
- [x] 7.4 Wire `bun run ask` script in `package.json`

## 8. Smoke test

- [x] 8.1 `bun run typecheck` returns 0
- [x] 8.2 (manual) `bun run watch` works
- [x] 8.3 `bun run ask "What is the EU AI Act?"` returns a summary
- [x] 8.4 Events appear in order: search.query → 3× scrape.fetch → llm.fast → summary.write
- [x] 8.5 `.sheldon/last-summary.md` contains the printed summary with `[1] [2] [3]` citations

## 9. Validate, document, archive

- [x] 9.1 `openspec validate add-search-loop` passes
- [ ] 9.2 Update `README.md` Status line and layer index (L2 done)
- [ ] 9.3 Update `AGENTS.md` layer-status table (L2 done)
- [ ] 9.4 `openspec archive add-search-loop --yes`
- [ ] 9.5 Verify `openspec/specs/searxng-client/`, `web-scraper/`, `search-loop/` exist; verify `event-log` updated
