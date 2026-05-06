## Context

We have an LLM client and an event log. L2 introduces the first interaction with the open web: SearXNG for querying, scraping for content extraction. The point is to validate this chain end-to-end on real pages before adding any agentic structure (frontier, claims, synthesis).

Vane's `baseSearch` (the project we studied earlier) does the same thing in much more elaborate code. We want the simplest version that produces something readable.

## Goals / Non-Goals

**Goals**

- One clean function `searchLoop.answer(question)` that returns a string
- Real-world resilience: when a page 404s or Readability gives up, skip and keep going
- Every step traceable in the event log
- Truncation discipline so we never blow past the 32k context

**Non-goals**

- Embedding rerank (L3 territory)
- Atomic claim extraction (L3)
- Multi-query expansion (L4)
- Result deduplication (L3)
- Anything stored in SQLite (L3)
- Pretty CLI output beyond plain text and stderr events
- Proper typed CLI arg parsing — `bun run ask "question"` is enough

## Decisions

### Decision 1: SearXNG over Tavily/Exa/Bing

**Why**: Already required by the broader project (privacy-focused, local). The sibling `local-research-agent` already runs one we can reuse. Free, no API keys, and we control engines later when we need academic/social search variants.

### Decision 2: Mozilla Readability + jsdom

**Why**: Battle-tested, what Firefox Reader View uses. Robust against real-world messy HTML. jsdom is the de facto Node DOM impl. Both are small and well-maintained.

**Alternatives considered**:
- `@extractus/article-extractor` — newer, sometimes better, but less consistent. Punt; we can swap if we find Readability failing on too many pages.
- Roll our own with regex / cheerio — bad idea, this is solved territory.
- Headless Chromium (Puppeteer) — overkill for L2, hits memory hard. Reserved for an L2.5 if we find too much JS-only content.

### Decision 3: Top 3 results, parallel scrape

**Why**: Three is enough to validate the pipeline and produces a readable summary. Parallel because we have nothing better to do while waiting; SearXNG already ranked them.

### Decision 4: Skip-and-continue on scrape failure

**Why**: The web is hostile. Paywalls, JS-only sites, 403s, Cloudflare blocks — all common. Throwing on the first failure means most queries return nothing. Returning `null` from the scraper and dropping nulls in the loop means we degrade gracefully. If all 3 fail, *then* we throw — that's a real signal.

### Decision 5: 24000-character truncation per page

**Why**: ~6000 tokens. Fits 3 pages × 6000 = 18000 tokens of content + ~2000 of instructions/question. Well under the 24k input budget at 32k context. Truncation is crude but acceptable for a pre-rerank layer.

### Decision 6: Write last-summary.md to disk

**Why**: Quick inspection without scrolling terminal output. Makes diff-comparing two runs trivial. Cheap. No DB until L3.

### Decision 7: Plain `searchLoop.answer(q)` function, not a class

**Why**: Stateless single-shot. Class would imply per-instance state we don't have.

## Risks / Trade-offs

- **[Risk] SearXNG instance offline.** → `bun run ask` errors out with a clear message. User starts the docker container and retries. Documented in the layer's tasks.md.
- **[Risk] Major news sites JavaScript-render their articles.** → Readability fails, we skip. Acceptable for L2; if we discover this is the dominant case, we add headless Chromium scraping later.
- **[Risk] Some sites block `Mozilla/5.0` UA or rate-limit us.** → Per-page timeout (15s) keeps us from hanging. The skip-and-continue pattern covers it.
- **[Trade-off] No deduplication of near-identical results.** → Three different sources of the same press release will produce a redundant summary. Acceptable; L3's claim extraction will dedupe at fact level.

## Migration Plan

Additive. No existing behavior changes. `bun run hello` still works.

## Open Questions

- Should we cache scraped pages so re-running the same question is instant? **Decided**: no caching yet. L3+ will think about this when scrapes feed claim extraction.
- Should the summarization prompt see snippet + scraped content, or just scraped content? **Decided**: scraped content only — snippets are mostly redundant after extraction.
- What if a page's HTML has 0 `<p>` tags but is technically valid? Readability handles most of these gracefully. If we see real failures, switch to `@extractus/article-extractor` as a fallback.
