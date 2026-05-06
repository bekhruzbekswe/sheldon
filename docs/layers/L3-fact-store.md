# L3 — Fact store

## Goal

Introduce structured, persistent memory: a SQLite database where every claim the agent extracts from a scraped page lives as a row, with its source URL and an embedding vector. After this layer, the agent stops being "summarize what you just read" and becomes "build a knowledge base about a question." L4 onward queries this store instead of re-reading raw pages.

This is also where chunking + embedding-rerank gets real, because we can't let the LLM see arbitrarily long pages.

## Capabilities introduced

- `chunker` — split arbitrary text into ~400-token chunks with ~80-token overlap, token-aware (uses a tiny tokenizer, not character counts)
- `embedder` — wraps `@xenova/transformers` to embed strings; runs in-process; uses `all-MiniLM-L6-v2` or similar
- `fact-store` — SQLite-backed table of `{id, claim, source_url, source_title, raw_excerpt, embedding, topic_tag, confidence, created_at}` with vector-similarity search
- `claim-extractor` — LLM prompt that takes a chunk + the question being researched, returns a JSON array of atomic claims with `confidence ∈ [0,1]`

## Dependencies

- L0 / `llm-client` — for claim extraction (uses `fast` mode + JSON response_format)
- L1 / `event-log` — every chunk, every claim write emits
- L2 / `web-scraper` — chunker takes scrape output as input

## Key data structures / decisions

**Database file:** `.sheldon/sheldon.db` (SQLite via `better-sqlite3`).

**Schema (draft):**
```sql
CREATE TABLE facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  claim TEXT NOT NULL,
  source_url TEXT NOT NULL,
  source_title TEXT,
  raw_excerpt TEXT,           -- the chunk text the claim came from
  embedding BLOB NOT NULL,    -- packed Float32Array
  topic_tag TEXT,             -- LLM-suggested tag, freeform; clusters in L6
  confidence REAL,            -- 0..1 from extractor
  question_id INTEGER,        -- which frontier question generated this (filled in L4)
  created_at INTEGER NOT NULL -- unix epoch ms
);
CREATE INDEX idx_facts_source ON facts(source_url);
CREATE INDEX idx_facts_topic ON facts(topic_tag);
```

No native vector index — for our scale (hundreds, low thousands of facts), brute-force cosine in JS is fast enough. If we ever exceed ~10k facts, swap to `sqlite-vec` or `vss`.

**Chunker decisions:**
- Tokenizer: use `@xenova/transformers`'s built-in tokenizer for the embedding model — same token boundaries as embedding sees.
- Size: 400 tokens (fits easily inside the embedding model's 512-token window with margin).
- Overlap: 80 tokens.
- Splitting strategy: paragraph-aware; never split mid-sentence; if a paragraph exceeds 400 tokens, fall back to sentence boundaries.

**Embedder decisions:**
- Model: `Xenova/all-MiniLM-L6-v2` for L3 — small, fast, 384-dim, well-tested. We may upgrade to `mxbai-embed-large` later if quality issues surface in L6 clustering.
- Batch size: embed up to 32 chunks per call. Stays well under the embedding model's memory footprint.

**Claim-extraction prompt (draft):**
- Mode: `llm.fast()` — happens hundreds of times per run, can't afford thinking.
- Response format: JSON schema with `{claims: [{text, confidence, topic_tag}]}` — strict.
- Instructions: extract atomic claims (one fact per claim), preserve numbers/dates/names, attach the URL exactly as input, don't paraphrase the source's stance, score confidence by how directly the source supports the claim.

**Inspect command:** `bun run inspect [--question N | --topic X | --limit 50]` dumps current facts to stdout in a readable table.

**Cosine-similarity search:** `factStore.findSimilar(embedding, { topK: 10, minSim: 0.5 })` — used by L4's deduplication and L6's clustering.

## Out of scope

- Frontier queue (L4)
- Cross-fact deduplication beyond exact-claim-match (L4 will handle near-duplicates)
- Synthesis / report writing (L6)
- Schema migrations / versioning — for a personal tool, drop+rebuild is fine if we change schema

## Open questions

- Should `topic_tag` be an enum constrained to a small set, or freeform LLM output? **Tentative:** freeform for now, cluster in L6. If clustering is unstable, revisit.
- Do we deduplicate claims at write time? Probably yes, by checking cosine similarity against existing facts in the store and skipping if `> 0.95`. Decide after seeing real extractor output.
- How do we handle the LLM occasionally returning malformed JSON? Use `partial-json` or just retry once with the same prompt; if still bad, log and skip.
