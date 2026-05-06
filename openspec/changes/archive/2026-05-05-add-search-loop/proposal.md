## Why

The agent has a voice (LLM, L0) and ears (event log, L1) but no eyes or hands yet. L2 introduces the simplest possible end-to-end pipeline that uses the web: take a question, do one SearXNG query, scrape the top 3 results, hand them to the LLM with citation instructions, return a summary.

This is not the research agent. It's a Q&A pipeline. The point is to validate the full search → scrape → LLM chain works against real-world pages and to surface friction (broken sites, paywalls, JS-only content) before we build structure on top in L3+.

Every step in the chain emits events to L1 so the user can read the run live or after.

## What Changes

- New `searxng-client` module that calls a running SearXNG instance and returns ranked results
- New `web-scraper` module that fetches a URL and uses Mozilla Readability + jsdom to extract clean article text
- New `search-loop` orchestrator that wires LLM + searxng + scraper into one "answer this question" function
- New `bun run ask "<question>"` CLI entrypoint
- New event kinds: `search.query`, `scrape.fetch`, `scrape.skip`, `summary.write`
- `last-summary.md` written to disk for inspection (no DB yet — that's L3)

Out of scope: embedding rerank, atomic claim extraction, follow-up questions, time budget. All later layers.

## Capabilities

### New Capabilities

- `searxng-client`: Call an HTTP-reachable SearXNG instance, parse JSON response, return ordered `{title, url, snippet}[]`. Handles timeout and basic error cases.
- `web-scraper`: Fetch a URL with a browser User-Agent and a hard timeout, parse HTML with jsdom, extract main content via Mozilla Readability, return cleaned plaintext + length metadata. Skips gracefully on non-HTML responses or extractor failures.
- `search-loop`: Single-shot orchestrator. Input: a question. Side effects: emits `search.query`, `scrape.fetch` (×N), and `summary.write` events. Output: an LLM-generated summary string with `[1] [2] [3]` citations.

### Modified Capabilities

- `event-log`: extend the `EventKind` taxonomy to include `search.query`, `scrape.fetch`, `scrape.skip`, `summary.write`.

## Impact

- Code: `src/search.ts`, `src/scrape.ts`, `src/loop.ts`, `src/ask.ts`. Modifies `src/events.ts` (kind union). `package.json` script.
- Dependencies: `jsdom`, `@mozilla/readability` (npm packages, both small).
- External: requires a running SearXNG instance reachable at `SEARXNG_BASE_URL` (default `http://localhost:8888`). The sibling `local-research-agent`'s docker-compose provides one; documented in tasks.md.
- Configuration: new env var `SEARXNG_BASE_URL` (defaults to `http://localhost:8888` if unset).
