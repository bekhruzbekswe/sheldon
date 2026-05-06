## ADDED Requirements

### Requirement: Embed an array of strings to fixed-dimension vectors

The `embedder.embed(texts)` function SHALL take a non-empty array of strings and return a `Float32Array[]` of the same length. Each vector MUST have exactly 384 dimensions (the size of `Xenova/all-MiniLM-L6-v2`'s output) and MUST be L2-normalized so cosine similarity reduces to a dot product.

#### Scenario: Returns matching length

- **WHEN** `embedder.embed(['a', 'b', 'c'])` resolves
- **THEN** the result is an array of length 3
- **AND** each element is a `Float32Array` of length 384

#### Scenario: Vectors are L2-normalized

- **WHEN** `embedder.embed(['hello world'])` resolves
- **THEN** the L2 norm of the returned vector is in `[0.99, 1.01]`

### Requirement: Lazy single-load model

The underlying transformer pipeline SHALL be loaded the first time `embed` is called and reused for subsequent calls. Importing the module MUST NOT load the model.

#### Scenario: Import is fast

- **WHEN** `import { embedder } from './embed'` runs
- **THEN** import completes in under 100ms (no model load triggered)

#### Scenario: First call loads, subsequent calls reuse

- **GIVEN** `embedder.embed(['x'])` was called once
- **WHEN** `embedder.embed(['y'])` is called
- **THEN** the second call does not trigger a model reload

### Requirement: Batch processing with capped batch size

If the input array has more than 32 strings, the embedder SHALL split into batches of ≤32 internally and concatenate results. The caller MUST observe behavior identical to a single call.

#### Scenario: Large input is processed in batches

- **WHEN** `embedder.embed(arrayOfLength100)` is called
- **THEN** the result has length 100
- **AND** at least 4 `embed.batch` events have been emitted

### Requirement: Emit one event per batch

The embedder SHALL emit one `embed.batch` event per internal batch with `layer:'L3'`, `durationMs`, and `payload` containing `count` (items in batch).

#### Scenario: Single small call emits one batch event

- **WHEN** `embedder.embed(['a', 'b'])` resolves
- **THEN** exactly one `embed.batch` event has been emitted with `payload.count: 2`
