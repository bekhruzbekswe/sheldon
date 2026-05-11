# research-contract Specification (delta)

## ADDED Requirements

### Requirement: Draft a research contract at run-start

The system SHALL produce a research contract artifact at the start of every non-resume run via one `llm.fast` call with `response_format: json_schema`. The contract MUST be the JSON object `{core_question: string, sub_questions: string[], good_answer_contains: string[], out_of_scope: string[]}`. The system MUST persist the resulting JSON as a string in `run_state.contract_json` (set during `runStart`). The system MUST emit one `contract.drafted` event with `layer:'L5'`, `durationMs`, and a payload summarizing `subQuestionCount`, `goodAnswerCount`, `outOfScopeCount`, plus an `error` field on failure. The drafter MUST follow the existing structured-output contract (JSON-schema response_format, retry-once on parse failure, markdown-fence stripping as fallback).

#### Scenario: Successful draft persists JSON to run_state

- **GIVEN** an empty `run_state` and a task `"Pain points of outsourcing in AI age"`
- **WHEN** `runStart(task, deadlineAt)` is called and the LLM returns a valid contract
- **THEN** `run_state.contract_json` contains a JSON string parseable to `{core_question, sub_questions, good_answer_contains, out_of_scope}`
- **AND** `sub_questions` has 3–5 entries
- **AND** one `contract.drafted` event has been emitted

### Requirement: Cache the task embedding on run_state

The system SHALL embed the run's task string exactly once at `runStart` and persist the resulting Float32(384) vector as a Float32 little-endian BLOB in `run_state.task_embedding`. `getRunState()` MUST decode and return this embedding alongside the existing fields. Resume MUST read the embedding as-is (no re-embedding on resume).

#### Scenario: Task embedding is persisted and retrievable

- **WHEN** `runStart(task, deadlineAt)` completes
- **THEN** `run_state.task_embedding` is a non-null BLOB whose byte length is `384 * 4`
- **AND** `getRunState()` returns an object whose `taskEmbedding` is a `Float32Array` of length 384

#### Scenario: Resume reads the embedding without recomputing

- **GIVEN** a prior run wrote `run_state.task_embedding`
- **WHEN** the process restarts and `runResearch(task, {resume: true})` runs
- **THEN** the embedder is NOT called for the run's task during the resume path
- **AND** `getTaskEmbedding()` returns the previously-persisted vector

### Requirement: Lazily embed and cache out-of-scope items

On the first call to `getOutOfScopeEmbeddings()` after run-start (or after resume), the system SHALL embed every entry in the contract's `out_of_scope` array via one batched `embedder.embed` call and cache the resulting `Float32Array[]` in process memory. Subsequent calls MUST return the cached array without re-embedding. If the contract's `out_of_scope` is empty, the function MUST return an empty array.

#### Scenario: Embedding happens once per process

- **GIVEN** a contract with `out_of_scope` of length 4
- **WHEN** `getOutOfScopeEmbeddings()` is called twice in the same process
- **THEN** the first call invokes `embedder.embed` exactly once
- **AND** the second call does not invoke the embedder

### Requirement: Graceful degradation on contract drafting failure

If the contract drafter LLM call fails (network, malformed JSON after retry, etc.), the system SHALL persist `run_state.contract_json = '{"core_question":"<task>","sub_questions":[],"good_answer_contains":[],"out_of_scope":[]}'`. The run MUST continue. The fact-store relevance gate MUST degrade to `cosine(fact, task) ≥ T_drop` (no out-of-scope subtraction), still serving as a real gate. The `contract.drafted` event MUST be emitted with an `error` payload describing the failure.

#### Scenario: Drafter failure does not abort run

- **GIVEN** the LLM endpoint returns malformed JSON twice in a row for the contract draft
- **WHEN** `runStart(task, deadlineAt)` is called
- **THEN** `run_state.contract_json` contains a contract with empty arrays for `sub_questions`, `good_answer_contains`, `out_of_scope`
- **AND** `runResearch` proceeds past `runStart` without throwing
- **AND** one `contract.drafted` event with a non-empty `error` payload field has been emitted
