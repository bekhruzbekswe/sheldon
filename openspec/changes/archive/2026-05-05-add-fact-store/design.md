## Context

L2 produces a one-off summary and discards everything. L3 is the layer that introduces persistent memory — every claim with its source, embedded for later retrieval. This is a much bigger layer than L0–L2 because it introduces three new dependencies (SQLite, in-process embeddings, structured LLM output) and ties them together with the chunking-then-extraction-then-storage flow.

The constraint we worked out earlier still holds: the LLM never sees raw pages. Pages are chunked into ~400-token windows, each window is embedded, and only the chunks closest to the current question's embedding will (in later layers) be reranked into prompts. For L3 we extract claims from every chunk; reranking comes in L4+.

## Goals / Non-Goals

**Goals**

- Persistent SQLite store of facts that survives across runs
- Token-aware chunker that aligns with the embedding model's tokenizer
- Local in-process embeddings (no API calls for this — privacy and speed)
- Structured LLM output via JSON-schema response_format, with one retry on malformed responses
- Cosine-similarity search over the store (brute force is fine at our scale)
- Auto-dedupe at insert time so the store doesn't fill with near-identical claims
- Wire L2's loop to populate the store in addition to its existing summary output

**Non-goals**

- Vector index optimizations (sqlite-vec, FAISS, etc.) — premature for ≤10k facts
- Schema migrations — drop/rebuild is fine for a personal tool
- Frontier queue and follow-up questions (L4)
- Cluster-then-write synthesis (L6)
- Full-text search across claims — we have embedding similarity, no need for BM25

## Decisions

### Decision 1: `bun:sqlite` (built-in) over external bindings

**Why**: Bun ships SQLite as a built-in module with a synchronous, prepared-statement API and BLOB support out of the box. We initially considered `better-sqlite3`, but Bun does not yet support its native binding (Bun issue #4290). `bun:sqlite` is a clean fit: zero install, fast, and the API surface we need (prepared statements, BLOB columns, simple migrations) is fully covered.

**Alternatives considered**:
- `better-sqlite3` — best-in-class Node binding, but Bun-incompatible right now.
- `lowdb` / JSON file — fast to start with, slow once we have thousands of facts.
- `duckdb` — overkill for our size.

### Decision 2: `@xenova/transformers` for embeddings

**Why**: Pure-JS Transformers running ONNX models, no Python, no GPU required. Loads once, runs in-process, latency is ~10ms per chunk on M-series Macs. `Xenova/all-MiniLM-L6-v2` is the well-known 384-dim sentence embedding model; small enough to download in seconds, fast enough to embed hundreds of chunks in under a minute.

**Alternatives considered**:
- Hosted embedding API (Cohere, OpenAI, Mistral) — privacy violation and adds another network dependency.
- Run a separate llama.cpp instance with an embedding model — works but adds infra; we'd rather keep embeddings local-process.
- Larger embedding models (`mxbai-embed-large`, 1024-dim) — better quality but 4× the memory and 3× the latency. We can swap later if cluster quality in L6 turns out poor.

### Decision 3: L2-normalize embeddings, store as Float32 BLOB

**Why**: Cosine similarity reduces to a dot product on L2-normalized vectors, which is faster and removes a normalization step in every search call. Float32 (4 bytes × 384 dim = 1536 bytes per fact) is a reasonable trade-off; Float16 would halve storage but cost portability headaches and isn't worth it at our scale.

### Decision 4: Brute-force cosine in JS, no native vector index

**Why**: For our expected scale (≤5000 facts in a 5-hour run), 5000 × 384 dot products is ~5ms in plain JS. Adding a vector index now is premature optimization. If we ever exceed ~10k facts, swap to `sqlite-vec` or a similar native binding.

### Decision 5: Dedupe at insert time, threshold 0.95

**Why**: Multiple sources will assert the same fact ("EU AI Act entered force August 2024"). If we don't dedupe, the store fills with redundancy and downstream reranking gets noisy. 0.95 is the empirical sweet spot in many RAG setups — distinct enough that genuinely different facts pass through, similar enough that paraphrases of the same fact get caught. We log dedupes via `fact.dedupe` events so we can re-tune the threshold.

**Alternatives considered**:
- Dedupe at retrieval time — defers the problem; insertion-time is cheaper because we already have the embedding.
- Exact-text dedupe only — too lenient; `"71% of US workers worry"` and `"71 percent of US workers worry"` both get through.

### Decision 6: JSON-schema structured output for claim extraction

**Why**: Free-form LLM output for "give me a list of claims" produces inconsistent shapes (sometimes Markdown bullets, sometimes JSON, sometimes prose). `response_format: {type:'json_schema', json_schema:{...}}` makes llama.cpp's grammar-constrained output enforce the shape. Mistakes drop dramatically. Already verified the endpoint supports this in earlier session work.

### Decision 7: One retry on malformed JSON, then return `[]`

**Why**: Even with grammar-constrained output, an occasional empty/garbage response is possible (model timeout, weird input). Retrying once handles transient failures. Returning `[]` and emitting an error event lets the agent's main loop continue — losing one chunk's claims is much better than killing the run.

### Decision 8: Chunker uses the embedder's tokenizer

**Why**: If chunks reported "400 tokens" but the embedding tokenizer counted 450, every chunk would silently overflow the 512-token embedding window and the model would silently truncate, making retrieval quality unpredictable. Sharing the tokenizer eliminates this class of bug.

### Decision 9: Wire L3 into L2's existing flow rather than adding a new entrypoint

**Why**: For a `bun run ask` smoke test, populating the fact store should happen as a side effect of every search. Otherwise we'd have to remember to run "ask, then index" as two steps. The summary still gets written; the store is now also populated.

## Risks / Trade-offs

- **[Risk] First run downloads a 25 MB model.** → Acceptable; happens once, cached at `~/.cache/huggingface/`.
- **[Risk] Brute-force cosine becomes slow past ~50k facts.** → We won't hit that in any plausible 5-hour run. Documented for future swap.
- **[Risk] Claim extraction occasionally fabricates ("hallucinates") claims not in the chunk.** → The prompt explicitly forbids this and asks for confidence. We accept some noise; L4's frontier scoring and L6's cluster pruning will deprioritize low-confidence facts. Monitor the `claim.extract` events to see if this becomes a real problem.
- **[Risk] `bun:sqlite` is Bun-only.** → We're already committed to Bun across the project; not a real portability concern. If we ever migrate runtimes this is one of three modules to swap.
- **[Trade-off] Embedding every claim before deduping (rather than dedupe by claim text first) costs an extra embed call per claim.** → Tiny in absolute terms (~20ms each), and exact text dedupe is too brittle. Worth it.
- **[Trade-off] `chunk.split` + `embed.batch` + `claim.extract` + `fact.write` produces lots of events.** → Watch can filter; the tail-the-fire-hose problem is theoretical at our event rate.

## Migration Plan

Additive. `bun run ask` continues to work identically; it now also populates `.sheldon/sheldon.db`. No data migration. If schema changes, drop the .db and re-run.

## Open Questions

- Do we ever delete facts? **Decided**: not in L3. L7's resume might offer a `--fresh` flag that wipes; that's its concern.
- Should embeddings live in a separate table for query performance? **Decided**: no; SQLite handles BLOB columns fine and the join would just slow brute-force search.
- How do we tune the dedupe threshold (0.95)? **Pending**: revisit after first L4 run when we can see real-world dedupe rates.
- Should we cache embeddings of identical input strings? **Pending**: not worth it yet; `embedder` callers usually pass unique text.
