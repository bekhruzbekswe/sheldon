## MODIFIED Requirements

### Requirement: Single-shot question → summary pipeline

The `searchLoop.answer(question)` function SHALL run the following sequence and return the final summary string:

1. Call `searxngClient.query(question)`.
2. Take the top 3 result URLs.
3. Call `scraper.fetch(url)` on each in parallel; drop nulls.
4. **For each surviving source: chunk its text, embed each chunk, extract claims via `extractor.extract`, embed each claim's text, and `factStore.insert` each (deduplicating against existing facts at cosine ≥ 0.95).** This step runs in parallel across sources.
5. Build a prompt that includes the question and the surviving scraped articles as numbered `<result index=N url=… title=…>...text...</result>` blocks.
6. Call `llm.fast(messages)` with a system instruction to summarize concisely with `[N]` citations.
7. Write the result to `.sheldon/last-summary.md` (replacing prior content) and emit one `summary.write` event.
8. Return the summary string.

#### Scenario: End-to-end happy path

- **GIVEN** SearXNG returns ≥3 results and at least 2 scrape successfully
- **WHEN** `searchLoop.answer('What is the EU AI Act?')` is called
- **THEN** the function resolves to a non-empty string
- **AND** `.sheldon/last-summary.md` exists with the same content
- **AND** the event log contains, in order: `search.query`, then ≥1 `scrape.fetch` (and possibly `scrape.skip`), then for each successful source `chunk.split` + ≥1 `embed.batch` + `claim.extract` + ≥0 `fact.write`/`fact.dedupe`, then `llm.fast`, then `summary.write`
- **AND** at least one row exists in the `facts` table after the call returns
