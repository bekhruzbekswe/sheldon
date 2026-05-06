## ADDED Requirements

### Requirement: Emit a structured event for every LLM call

For each invocation of `fast()` or `deep()`, the `LlmClient` SHALL emit one event to the event log with kind `llm.fast` or `llm.deep` respectively, layer `L0`, `durationMs` set to the call latency, and `payload` containing `prompt_tokens`, `completion_tokens`, `total_tokens`, and a short text excerpt of the user's last message (≤80 chars). Failed requests MUST also emit an event with the same kind plus an `error` field in the payload before the error is thrown.

#### Scenario: Successful fast call emits an event

- **GIVEN** the event log is empty
- **WHEN** `llm.fast([{role:'user', content:'2+2'}])` resolves successfully
- **THEN** exactly one event has been emitted with `kind='llm.fast'`, `layer='L0'`, a positive `durationMs`, and a payload containing `prompt_tokens`, `completion_tokens`, `total_tokens`

#### Scenario: HTTP 401 also emits an event

- **GIVEN** an invalid API key is configured
- **WHEN** `llm.fast([...])` is called
- **THEN** one event with `kind='llm.fast'` is emitted whose payload includes an `error` field containing `401`
- **AND** the original Error is then thrown to the caller
