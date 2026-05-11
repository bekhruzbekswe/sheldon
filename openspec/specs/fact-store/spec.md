# fact-store Specification

## Purpose

Persistent SQLite store of atomic claims with 384-dim embeddings, source attribution, optional topic tags, and confidence scores. Auto-deduplicates near-duplicates (cosine ≥ 0.95) at insert time. Provides brute-force cosine similarity search for downstream retrieval (L4 frontier dedupe, L6 cluster-then-write synthesis). The agent's external long-term memory.

## Requirements
### Requirement: SQLite-backed persistent store at .sheldon/sheldon.db

The fact store SHALL persist to `.sheldon/sheldon.db` (SQLite via Bun's built-in `bun:sqlite`). On first use it MUST run idempotent CREATE TABLE / CREATE INDEX statements. The schema MUST include a `facts` table with columns: `id INTEGER PK AUTOINCREMENT`, `claim TEXT NOT NULL`, `source_url TEXT NOT NULL`, `source_title TEXT`, `raw_excerpt TEXT`, `embedding BLOB NOT NULL`, `topic_tag TEXT`, `confidence REAL`, `question_id INTEGER`, `created_at INTEGER NOT NULL`. Indexes MUST cover `source_url` and `topic_tag`.

#### Scenario: First use creates database

- **GIVEN** `.sheldon/sheldon.db` does not exist
- **WHEN** any `factStore` method is called
- **THEN** the file exists
- **AND** querying `sqlite_master` returns a row with `type='table'` and `name='facts'`

### Requirement: Insert a fact with embedding

The `factStore.insert(fact)` function SHALL accept `{claim, sourceUrl, sourceTitle?, rawExcerpt?, embedding, topicTag?, confidence?, questionId?}` and insert one row, packing the embedding as a binary blob (Float32Array little-endian). `created_at` MUST be set to `Date.now()` automatically. The function MUST return the inserted row's `id`.

#### Scenario: Insert returns id

- **WHEN** `factStore.insert({claim:'2+2=4', sourceUrl:'https://x', embedding: new Float32Array(384)})` is called
- **THEN** the function returns a positive integer
- **AND** that row is retrievable via the returned id

### Requirement: Deduplicate near-duplicates on insert

If a candidate fact's embedding has cosine similarity ≥ 0.95 to an existing fact's embedding (any source), `factStore.insert` SHALL skip the write, return `null`, and emit one `fact.dedupe` event whose payload references the existing fact's id and the candidate's claim text (≤80 chars).

#### Scenario: Near-duplicate is dropped

- **GIVEN** the store already contains a fact with embedding `e1`
- **WHEN** `factStore.insert({claim:'similar claim', embedding: e2})` runs and `cosine(e1, e2) >= 0.95`
- **THEN** the function returns `null`
- **AND** one `fact.dedupe` event has been emitted with `payload.matchedId` referencing the existing fact

#### Scenario: Distinct fact is written

- **GIVEN** the store contains a fact `e1`
- **WHEN** `factStore.insert({claim:'unrelated', embedding: e2})` runs and `cosine(e1, e2) < 0.95`
- **THEN** the function returns a new id
- **AND** one `fact.write` event has been emitted

### Requirement: Brute-force cosine similarity search

The `factStore.findSimilar(queryEmbedding, opts?)` function SHALL return the top-K facts ranked by cosine similarity. Default `topK` is 10, default `minSim` is 0.5. Each returned object MUST include the fact's row plus a `similarity` field in `[-1, 1]`.

#### Scenario: Returns ranked similar facts

- **GIVEN** the store contains 20 facts
- **WHEN** `factStore.findSimilar(queryEmb, {topK: 5, minSim: 0.4})` runs
- **THEN** the returned array has at most 5 entries
- **AND** every entry's `similarity >= 0.4`
- **AND** entries are sorted by `similarity` descending

### Requirement: List facts with filters

The `factStore.list(opts?)` function SHALL return rows ordered by `created_at` descending, with support for `{limit?, sourceUrl?, topicTag?}` filters. Embeddings MAY be omitted from the returned objects to keep payloads small.

#### Scenario: Filter by source

- **GIVEN** the store contains facts from 3 distinct URLs
- **WHEN** `factStore.list({sourceUrl: 'https://x'})` runs
- **THEN** every returned row has `sourceUrl === 'https://x'`

### Requirement: Emit fact.write event on successful insert

Each successful insert SHALL emit one `fact.write` event with `layer:'L3'`, no `durationMs`, and `payload` containing `id`, `claim` (≤80 chars), `sourceUrl`, `topicTag`, `confidence`.

#### Scenario: Write event is emitted

- **WHEN** `factStore.insert({...})` returns a new id
- **THEN** one `fact.write` event with that id is appended to the event log

### Requirement: Drop facts that fail the relevance gate

`factStore.insert` SHALL consult the cached task embedding (from `getTaskEmbedding()`) and the cached out-of-scope embeddings (from `getOutOfScopeEmbeddings()`) before performing the existing dedupe scan. The gate score is:

```
score = cosine(fact_embedding, task_embedding)
      − max_i( cosine(fact_embedding, oos_embedding_i) )    // 0 if oos is empty
```

If `score < T_drop` (per-file constant in `facts.ts`; empirically tuned starting value `T_drop = -0.10` after first-run telemetry showed `T_drop = 0.05` rejected 94% of extracted claims due to natural overlap between `taskSim` and `maxOosSim` in MiniLM-L6's similarity space), the function SHALL return `null` without inserting and emit one `fact.dropped.irrelevant` event with `layer:'L3'`, no `durationMs`, and payload `{claim, sourceUrl, taskSimilarity, maxOosSimilarity, score, threshold}`. All similarity values in the payload are `Number(x.toFixed(4))`-truncated.

If the run has no contract (e.g., contract drafting failed and the contract module returned an empty contract), `oos_embedding` is empty and the gate degrades to `score = cosine(fact_embedding, task_embedding)`.

#### Scenario: Off-topic fact is dropped

- **GIVEN** the run's task is `"Pain points of outsourcing in AI age"`
- **AND** the contract's `out_of_scope` includes `"API monitoring dashboards"`
- **WHEN** `factStore.insert({claim:'Cloud Monitoring shows median latency for enabled APIs', sourceUrl:'…', embedding: e})` runs and the gate score is below `T_drop`
- **THEN** the function returns `null`
- **AND** one `fact.dropped.irrelevant` event has been emitted with the claim text and similarity values
- **AND** no row is inserted into `facts`

#### Scenario: Relevant fact passes the gate and proceeds to dedupe check

- **GIVEN** the run's task and contract are populated
- **WHEN** `factStore.insert({claim:'BPO firms face disruption from AI agents', embedding: e})` runs and the gate score is at or above `T_drop`
- **THEN** the function does NOT return `null` for relevance reasons
- **AND** the existing cosine-≥-0.95 dedupe scan runs next

#### Scenario: Empty out-of-scope degrades gate to plain task cosine

- **GIVEN** the contract's `out_of_scope` array is empty
- **WHEN** `factStore.insert(...)` runs
- **THEN** the gate score is `cosine(fact_embedding, task_embedding)` only
- **AND** the gate still drops facts when this score is below `T_drop`

### Requirement: Relevance gate runs before the dedupe scan

The order of checks inside `factStore.insert` SHALL be: (1) relevance gate, (2) dedupe scan, (3) row insert. Failing the gate MUST short-circuit before the O(n) dedupe scan.

#### Scenario: Dropped fact does not trigger dedupe scan

- **GIVEN** the store contains 1000 facts (a non-trivial dedupe-scan cost)
- **WHEN** `factStore.insert(input)` runs and the relevance gate fails
- **THEN** the function returns `null` without iterating over the existing rows
- **AND** zero `fact.dedupe` events are emitted for this call

