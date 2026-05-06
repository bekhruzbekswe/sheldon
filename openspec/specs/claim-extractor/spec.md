# claim-extractor Specification

## Purpose

LLM-driven extractor that turns one chunk of text plus the user's research question into a JSON list of atomic claims with confidence ∈ [0,1] and a freeform topic tag. Uses `llm.fast` with a JSON-schema `response_format` for grammar-constrained output, retries once on malformed responses, and gracefully returns an empty array (with an `error` event) on persistent failure.

## Requirements
### Requirement: Extract atomic claims from a chunk

The `extractor.extract(chunk, ctx)` function SHALL accept a chunk text and a context `{question, sourceUrl, sourceTitle?}`, call `llm.fast` with a system prompt instructing atomic-claim extraction and a JSON `response_format`, and return an array of `{text, confidence, topicTag}`. Each claim's `confidence` MUST be in `[0, 1]`.

#### Scenario: Returns parsed claims

- **GIVEN** a chunk discussing the EU AI Act
- **WHEN** `extractor.extract(chunk, {question:'What is the EU AI Act?', sourceUrl:'https://...'})` resolves
- **THEN** the result is an array of `{text, confidence, topicTag}`
- **AND** each claim's `text` is a complete sentence
- **AND** each `confidence` is in `[0, 1]`

### Requirement: Survive malformed JSON with one retry

If the LLM's response cannot be parsed as JSON conforming to the schema, the extractor SHALL retry the call once with the same prompt. If the second response is still malformed, the function MUST log a `claim.extract` event whose payload includes `error` and return an empty array (do not throw).

#### Scenario: First-attempt malformed JSON triggers one retry

- **GIVEN** the LLM is wired to return malformed JSON the first time and valid JSON the second
- **WHEN** `extractor.extract(...)` runs
- **THEN** the LLM is called exactly twice
- **AND** the function returns the parsed claims from the second response

#### Scenario: Persistent malformed JSON returns empty

- **GIVEN** the LLM returns malformed JSON both times
- **WHEN** `extractor.extract(...)` runs
- **THEN** the function returns `[]`
- **AND** one `claim.extract` event has been emitted whose payload contains an `error` field

### Requirement: Emit one event per extraction call

The extractor SHALL emit a `claim.extract` event with `layer:'L3'`, `durationMs`, and `payload` containing the chunk's source URL, claim count, and average confidence (or `error` on failure).

#### Scenario: Successful extraction emits an event

- **WHEN** `extractor.extract(...)` returns 6 claims
- **THEN** one `claim.extract` event has been emitted with `payload.claimCount: 6`

### Requirement: Use fast mode (no thinking)

The extractor SHALL call `llm.fast` (not `llm.deep`). Thinking-mode reasoning is wasted on this templated, high-frequency operation.

#### Scenario: No reasoning content returned

- **WHEN** `extractor.extract(...)` runs
- **THEN** the underlying LLM response's `reasoning_content` is empty

