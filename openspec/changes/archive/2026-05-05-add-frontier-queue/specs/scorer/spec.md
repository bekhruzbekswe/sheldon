## ADDED Requirements

### Requirement: Combine relevance, novelty, and depth-decay into one score

The `score(input)` function SHALL accept `{relevance, novelty, depth}` (all numbers, `relevance` and `novelty` in `[0, 1]`, `depth` a non-negative integer) and return a number in `[0, 1]` computed as:

```
0.5 * relevance + 0.3 * novelty + 0.2 * (0.9 ** depth)
```

The function MUST be pure (no side effects, no I/O).

#### Scenario: Score formula matches the documented coefficients

- **WHEN** `score({relevance: 0.8, novelty: 0.6, depth: 2})` is called
- **THEN** the return value equals `0.5*0.8 + 0.3*0.6 + 0.2*0.81` (i.e. `0.742`) within floating-point tolerance

### Requirement: Compute novelty from existing frontier embeddings

The `computeNovelty(candidateEmbedding, existingEmbeddings)` helper SHALL return `1 - max(cosineSimilarity)` over all existing embeddings (or `1` if the array is empty). Inputs MUST be L2-normalized Float32Arrays so the cosine reduces to a dot product.

#### Scenario: Empty frontier yields novelty 1

- **WHEN** `computeNovelty(e, [])` is called
- **THEN** the result is `1`

#### Scenario: Identical embedding yields novelty 0

- **WHEN** `computeNovelty(e, [e])` is called (the same Float32Array)
- **THEN** the result is in `[0, 0.01]` (allowing for floating-point error)
