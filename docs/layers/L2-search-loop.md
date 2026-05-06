# L2 — Single search loop

## Goal

Wire the simplest possible "answer one question with web help" pipeline end-to-end: take a question, do **one** SearXNG query, scrape the top 3 results, ask the LLM to summarize. No frontier, no time budget, no fact store, no follow-ups. The point is to validate the full search → scrape → LLM chain works, and to feel out where the friction is before we start building structure on top.

Every step writes events to L1's log so we can read the run after the fact.

## Capabilities introduced

- `searxng-client` — POST/GET to a SearXNG instance, parse JSON response, return `{title, url, snippet, score}[]`
- `web-scraper` — fetch a URL, run `@mozilla/readability` on it, return cleaned plaintext + length stats
- `search-loop` — orchestrator that ties the LLM client + searxng-client + web-scraper together for one question and returns a summary

## Dependencies

- L0 / `llm-client`
- L1 / `event-log` (every action emits)

## Key data structures / decisions

**SearXNG instance:** reuse the sibling `local-research-agent`'s docker-compose (port 8888). Don't bundle our own. Document in the layer's `tasks.md` that the SearXNG container must be running.

**Search params (draft):**
```ts
searxng.query("AI job displacement studies", {
  format: "json",
  categories: ["general"],
  // engines: undefined — accept defaults for L2
})
```
No engine specialization yet (academic/social variants come later).

**Scrape choice:** `@mozilla/readability` + `jsdom` over the page's HTML. Readability is what Firefox's "Reader View" uses — it's good at stripping nav/ads/footers and leaving the article content.

**Content size handling:** if the cleaned text exceeds ~6000 tokens, truncate to first 6000 with a note in the event log. We'll do real chunking in L3 when claim extraction needs it; L2's summarizer can tolerate truncation.

**Summarization prompt (draft):**
> "You are summarizing search results to answer a user's question. Be concise; cite each result by its index `[1]`, `[2]`, `[3]`."

Inputs to the prompt: the original question, plus three numbered blocks of `<result index=N url=… title=…>...content...</result>`.

**Mode:** `llm.fast()`. No thinking needed for a synthesis-of-three.

## Out of scope

- Embedding rerank (L3 territory — keep L2's results in raw search-engine order)
- Atomic claim extraction (L3)
- Iterating to follow-up questions (L4)
- Time budget (L5)
- Citation post-processing — let the LLM cite naturally; we'll structure it later

## Open questions

- Is `@mozilla/readability` the right choice, or is `@extractus/article-extractor` better in May 2026? Decide at promotion time.
- How many search results should we ask SearXNG for? L2 uses 3 to keep it simple; later layers might want 10+.
- Should L2's summary be saved anywhere? **Tentative answer:** print to stdout and write a `last-summary.md` for inspection. No DB until L3.
