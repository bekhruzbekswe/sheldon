## ADDED Requirements

### Requirement: Propose follow-up questions from recent claims

The `proposer.propose(ctx)` function SHALL accept `{originalTask, parentQuestion, recentClaims, pendingTitles}` and return 3–5 `{question, relevance, why}` entries. `relevance` MUST be in `[0, 1]`. `why` is a one-line debug string explaining the proposal. The function MUST use `llm.fast` with a JSON-schema `responseFormat`.

#### Scenario: Returns 3-5 follow-ups

- **GIVEN** a parent question and 8 recent claims about EU AI Act
- **WHEN** `proposer.propose({...})` resolves
- **THEN** the result has between 3 and 5 entries
- **AND** every entry's `relevance` is in `[0, 1]`

### Requirement: Recent claims and pending titles bound input size

The proposer SHALL accept at most 10 recent claims (caller-truncated) and at most 5 pending frontier titles. The prompt MUST stay under 3000 input tokens regardless of claim length (longer claims get truncated to ≤200 chars each).

#### Scenario: Long claims are truncated in prompt

- **GIVEN** a recentClaims array where some entries exceed 500 characters
- **WHEN** `proposer.propose({...})` runs
- **THEN** the upstream LLM request body's user message contains each claim truncated to ≤200 chars

### Requirement: Survive malformed JSON with one retry

If the LLM returns malformed JSON, the proposer SHALL retry once. On persistent failure it MUST emit a `claim.extract` (semantic relative — same retry-then-empty pattern) — actually emit no extra event beyond the existing `iteration.end` and return `[]`.

Note: the proposer SHALL NOT emit a kind of its own; the caller is responsible for closing the iteration with `iteration.end` reflecting `proposalCount`.

#### Scenario: Persistent malformed JSON returns empty

- **GIVEN** the LLM returns malformed JSON twice in a row
- **WHEN** `proposer.propose(...)` runs
- **THEN** the function returns `[]`
- **AND** the function does not throw
