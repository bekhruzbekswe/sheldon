# fact-store Specification (delta)

## ADDED Requirements

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
