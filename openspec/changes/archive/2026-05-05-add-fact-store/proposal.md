## Why

L2 produces a one-off summary and discards everything: the scraped pages, the search results, the reasoning. For a multi-hour research agent, that's the wrong primitive. We need persistent, structured memory — every claim the agent finds saved with its source URL and an embedding, in a SQLite database that survives crashes and accumulates across iterations.

This is the layer that turns Sheldon from a Q&A tool into something that builds knowledge. After L3, the same scrape can be queried by L4 (frontier follow-ups: "have we already learned about X?") and L6 (synthesis: "give me all facts about regulation").

## What Changes

- New SQLite database at `.sheldon/sheldon.db` via `bun:sqlite` (Bun's built-in)
- New `chunker` that token-aware-splits scraped text into ~400-token chunks with ~80-token overlap
- New `embedder` that wraps `@xenova/transformers` running `Xenova/all-MiniLM-L6-v2` in-process
- New `claim-extractor` that takes a chunk + the original question and returns a JSON list of atomic claims via `llm.fast`
- New `fact-store` module: insert facts, brute-force cosine similarity search, dedupe by ≥0.95 cosine
- Wire L2's `searchLoop.answer` to chunk → extract → embed → store **in addition to** still writing the summary
- New `bun run inspect` CLI: dump current facts as a readable table with filters (`--limit`, `--topic`, `--source`)
- New event kinds: `chunk.split`, `embed.batch`, `claim.extract`, `fact.write`, `fact.dedupe`

Out of scope: frontier queue, follow-up question proposal, time budget, synthesis, schema migrations.

## Capabilities

### New Capabilities

- `chunker`: Token-aware splitting of arbitrary text into windowed chunks with paragraph→sentence fallback. Same tokenizer the embedder uses, so chunk boundaries align with embedding boundaries.
- `embedder`: In-process embedding via `Xenova/all-MiniLM-L6-v2` (384-dim). Lazy model load on first use, cached between calls. Batched for efficiency.
- `fact-store`: Persistent SQLite-backed table of facts with brute-force cosine similarity search. Auto-creates schema on first use. Insertion deduplicates against existing facts at cosine ≥ 0.95.
- `claim-extractor`: LLM prompt that turns a chunk into a JSON array of atomic claims with confidence and an optional topic tag. Uses `llm.fast` (no thinking) for throughput.

### Modified Capabilities

- `event-log`: extend `EventKind` to include `'chunk.split' | 'embed.batch' | 'claim.extract' | 'fact.write' | 'fact.dedupe'`.
- `llm-client`: gain an opt-in `responseFormat` parameter that lets callers pass an OpenAI-compatible `response_format` body field. Default behavior unchanged.
- `search-loop`: `searchLoop.answer(question)` now also extracts claims from each scraped source, embeds them, and writes to the fact store before producing the summary. Return value unchanged.

## Impact

- Code: `src/chunker.ts`, `src/embed.ts`, `src/db.ts`, `src/facts.ts`, `src/extract.ts`, `src/inspect.ts`. Modifies `src/llm.ts`, `src/loop.ts`, `src/events.ts`. New `bun run inspect` script.
- Dependencies: `@xenova/transformers` (in-process embedding model). SQLite is built into Bun (`bun:sqlite`); no npm dependency for it.
- Storage: first run downloads `Xenova/all-MiniLM-L6-v2` (~25 MB) into `~/.cache/huggingface/`. SQLite db lives at `.sheldon/sheldon.db`.
- Performance: claim extraction adds 1 LLM call per scraped source. For an L2 ask of 3 sources, that's ~3 extra fast-mode calls (~2-3s overhead total). Acceptable.
