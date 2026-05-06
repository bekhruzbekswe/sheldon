## ADDED Requirements

### Requirement: Cluster fact embeddings into ordered themes

The `clusterFacts(facts, opts?)` function SHALL accept an array of `{id, embedding, topicTag}` (plus other fields it MAY ignore) and return an array of clusters of the form `{label, factIds[], centroid}` sorted by `factIds.length` descending. Clustering MUST use k-means over the L2-normalized 384-dim embeddings (cosine distance reduces to dot product). The number of clusters `k` MUST be selected by silhouette score across `[opts.kMin ?? 5, opts.kMax ?? 10]`. Clusters with fewer than `opts.minSize ?? 5` facts MUST be dropped from the returned array (their facts are excluded; the surviving clusters do not absorb them).

#### Scenario: Basic clustering returns 5–10 clusters

- **GIVEN** 100 facts with diverse embeddings
- **WHEN** `clusterFacts(facts)` resolves
- **THEN** the returned array has between 1 and 10 clusters
- **AND** every cluster has `factIds.length >= 5`
- **AND** clusters are sorted by `factIds.length` descending

#### Scenario: Tiny clusters are dropped

- **GIVEN** 30 facts where 3 form a clearly distinct micro-cluster and 27 form a single big cluster
- **WHEN** `clusterFacts(facts, {minSize: 5})` runs
- **THEN** the result has exactly 1 cluster
- **AND** the 3 outlier facts do not appear in any returned cluster

### Requirement: Label each cluster

Each returned cluster SHALL have a `label` field. The labeling rule: if more than 50% of the cluster's facts share a single `topicTag`, use that tag (verbatim). Otherwise, generate a label from the top-3 nearest-to-centroid facts via a single `llm.fast` call requesting a short kebab-case noun phrase (≤4 words). On LLM failure, the label MUST fall back to the most common `topicTag` (even if minority) or the first cluster's `topicTag` of the cluster's largest fact.

#### Scenario: Dominant topic tag becomes the label

- **GIVEN** a cluster of 20 facts where 15 have `topicTag: 'eu-regulation'`
- **WHEN** the cluster is labeled
- **THEN** its `label` is `'eu-regulation'`

### Requirement: Emit one event per clustering call

`clusterFacts` SHALL emit exactly one `cluster.computed` event on success with `layer:'L6'`, `durationMs`, and `payload` containing `factCount`, `k`, `clusterCount`, `silhouette` (rounded to 3 decimals), and an array of `{label, size}` summaries.

#### Scenario: Cluster event populated

- **WHEN** `clusterFacts(...)` returns 6 clusters of sizes [40, 30, 20, 15, 10, 7]
- **THEN** one `cluster.computed` event has been emitted with `payload.clusterCount: 6` and `payload.k: 6`
