## ADDED Requirements

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
