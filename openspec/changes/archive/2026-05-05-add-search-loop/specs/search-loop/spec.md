## ADDED Requirements

### Requirement: Single-shot question → summary pipeline

The `searchLoop.answer(question)` function SHALL run the following sequence and return the final summary string:

1. Call `searxngClient.query(question)`.
2. Take the top 3 result URLs.
3. Call `scraper.fetch(url)` on each in parallel; drop nulls.
4. Build a prompt that includes the question and the surviving scraped articles as numbered `<result index=N url=… title=…>...text...</result>` blocks.
5. Call `llm.fast(messages)` with a system instruction to summarize concisely with `[N]` citations.
6. Write the result to `.sheldon/last-summary.md` (replacing prior content) and emit one `summary.write` event.
7. Return the summary string.

#### Scenario: End-to-end happy path

- **GIVEN** SearXNG returns ≥3 results and at least 2 scrape successfully
- **WHEN** `searchLoop.answer('What is the EU AI Act?')` is called
- **THEN** the function resolves to a non-empty string
- **AND** `.sheldon/last-summary.md` exists with the same content
- **AND** the event log contains, in order: `search.query`, then ≥1 `scrape.fetch` (and possibly `scrape.skip`), then `llm.fast`, then `summary.write`

### Requirement: At least one source must succeed

If all 3 scrapes return null, the loop SHALL throw an Error mentioning `no usable sources` rather than calling the LLM with empty context.

#### Scenario: Total scrape failure

- **GIVEN** all top-3 results return null from `scraper.fetch`
- **WHEN** `searchLoop.answer(...)` is called
- **THEN** the call throws with a message containing "no usable sources"

### Requirement: Summary writer is the L2 layer

The summary write event SHALL carry `layer:'L2'` and `payload` containing the question (truncated), the count of sources used, and the byte size of the written file.

#### Scenario: Summary write event populated

- **WHEN** the loop writes a summary
- **THEN** one `summary.write` event is appended whose payload contains `question`, `sourceCount`, and `bytes`
