# question-decomposer Specification

## Purpose

LLM-driven seed generator. Turns a user research task into ~12 well-scoped sub-questions, each tagged with a topic and an initial productivity score in [0.5, 0.9]. Used at the start of every research run to populate the frontier queue. Uses `llm.fast` with JSON-schema response_format for grammar-constrained output.

## Requirements
### Requirement: Decompose a research task into seed questions

The `decomposer.decompose(task, opts?)` function SHALL accept the user's research task and return an array of seed `{question, topicTag, score}` entries. By default it MUST request 12 seed questions (configurable via `opts.count`). Each question's `score` MUST be in `[0.5, 0.9]` and represent the LLM's prior on that question's likely productivity. Each `topicTag` MUST be a short freeform label (≤4 hyphenated words).

#### Scenario: Returns 12 seed questions by default

- **WHEN** `decomposer.decompose('What are the top pain points of the AI age?')` resolves
- **THEN** the result has between 8 and 16 entries (LLM may emit slightly fewer/more)
- **AND** each entry has `question`, `topicTag`, and `score`
- **AND** each `score` is in `[0.5, 0.9]`

### Requirement: Use llm.fast with JSON-schema response format

The decomposer SHALL call `llm.fast` (no thinking) with a `responseFormat: {type:'json_schema', ...}` enforcing the output shape. On malformed JSON it MUST retry once; on persistent failure it MUST emit a `frontier.seed` event with `error` and return an empty array.

#### Scenario: Persistent malformed JSON returns empty

- **GIVEN** the LLM is wired to return malformed JSON twice
- **WHEN** `decomposer.decompose(...)` runs
- **THEN** the function returns `[]`
- **AND** one `frontier.seed` event has been emitted whose payload contains an `error` field

### Requirement: Emit one event per decomposition

On success the decomposer SHALL emit one `frontier.seed` event with `layer:'L4'`, `durationMs`, and `payload` containing the truncated task, `seedCount`, and the average score.

#### Scenario: Seed event populated

- **WHEN** `decomposer.decompose('AI pain points')` returns 10 questions with mean score 0.72
- **THEN** one `frontier.seed` event has been emitted with `payload.seedCount: 10`

