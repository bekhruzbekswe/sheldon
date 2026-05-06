# scorer Specification

## Purpose

Pure scoring helpers. `score({relevance, novelty, depth})` combines an LLM-given relevance prior, embedding-distance novelty, and depth-decay into one priority in [0,1]. `computeNovelty(candidate, existing)` returns `1 - max cosine` to existing frontier embeddings (1 if empty). No I/O, no events — just math.
## Requirements
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

### Requirement: Phase-aware scoring weights

The `score(input)` function SHALL accept an additional optional `phase` parameter (`'breadth' | 'depth' | 'synthesis'`). When omitted or `'breadth'`, the function uses breadth-favoring coefficients (relevance 0.4, novelty 0.5, depth 0.1) and a sharp depth penalty (`0.7^depth`). When `'depth'`, it uses depth-favoring coefficients (relevance 0.5, novelty 0.15, depth 0.35) and a depth bonus (`min(1.5, 1.0 + 0.05*depth)` clamped). When `'synthesis'`, the function MUST return `0` for every input (search is locked off; the score is meaningless).

#### Scenario: Breadth phase favors novelty

- **GIVEN** two inputs, one with high novelty and shallow depth, one with low novelty and deep depth
- **WHEN** `score(...)` is called for each in `'breadth'` phase
- **THEN** the high-novelty shallow input has a strictly greater score

#### Scenario: Depth phase favors deeper threads

- **GIVEN** two inputs with identical relevance and novelty but depths 0 and 3
- **WHEN** `score(...)` is called for each in `'depth'` phase
- **THEN** the depth=3 input has a strictly greater score

#### Scenario: Synthesis phase returns zero

- **WHEN** `score(anyInput, 'synthesis')` is called
- **THEN** the result is `0`

### Requirement: Default behavior preserved when phase is omitted

If the caller does not pass a `phase`, the function SHALL behave exactly as it did before this change (i.e., as if `'breadth'` were passed). This guarantees existing call sites that haven't been migrated continue to work.

#### Scenario: No phase argument matches breadth

- **WHEN** `score(input)` and `score(input, 'breadth')` are called with the same input
- **THEN** they return the same value

