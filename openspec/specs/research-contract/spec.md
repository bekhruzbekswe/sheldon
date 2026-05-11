# research-contract Specification

## Purpose

The research contract is the run-start artifact that translates a user's research task into a structured object the rest of the agent consults: `{core_question, sub_questions[], good_answer_contains[], out_of_scope[]}`. It powers the L3 relevance gate (out_of_scope items as rejection signal) and gives downstream stages an explicit record of what's in and out of scope. Persisted on `run_state` so resume sees the same contract that drove the original run.

## Requirements

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

### Requirement: Revise the contract's out_of_scope at phase boundaries

The system SHALL provide a `reviseContract(phaseTransition, currentContract, droppedSamples, borderlineSamples)` function in `src/contract.ts` invoked once at each phase boundary by the research orchestrator (alongside the gap-analyzer). On each call:

1. `llm.fast` is invoked with the project-wide structured-output pattern (`response_format: json_schema`, retry-once, markdown-fence strip).
2. The prompt receives the current contract (especially `core_question` and current `out_of_scope`), a sample of facts the relevance gate dropped (so the LLM can see what was rejected and why), and a sample of repeated-but-borderline claims that snuck through the gate.
3. The LLM returns a revised `out_of_scope` array (3-5 items, full replacement). The prompt instructs the model to KEEP existing items unless the gathered facts have proven them irrelevant (i.e., legitimate adjacent content was being rejected) and to ADD new items only for adjacencies that consistently slipped through and turned out to be off-topic.
4. The returned `out_of_scope` array is persisted by writing the updated full contract JSON to `run_state.contract_json` via `getDb()`.
5. The in-process `oosEmbCache` and `contractCache` are invalidated. The next call to `getOutOfScopeEmbeddings()` re-embeds with the new items.
6. Past inserted facts are NOT retroactively re-gated. The relevance gate runs only on new inserts.

The function MUST emit one `contract.revised` event with `layer: 'L5'`, `durationMs`, payload `{phaseTransition, oosBefore: string[], oosAfter: string[], removed: string[], added: string[], error?}`.

If the LLM call fails after retry or returns malformed JSON, the function SHALL leave the contract unchanged and emit `contract.revised` with `error` populated. The run continues.

#### Scenario: Successful revision updates contract_json and invalidates cache

- **GIVEN** a contract with `out_of_scope: ['API monitoring dashboards', 'p95 latency alerting']`
- **WHEN** `reviseContract(transition, contract, dropped, borderline)` is called and the LLM returns a revised `['p95 latency alerting', 'recruiting tools', 'cloud-infra finance commentary']`
- **THEN** `run_state.contract_json` is updated with the new full contract
- **AND** the next call to `getContract()` returns the revised object
- **AND** the next call to `getOutOfScopeEmbeddings()` re-embeds (the in-process cache was invalidated)
- **AND** one `contract.revised` event has been emitted with `removed: ['API monitoring dashboards']` and `added: ['recruiting tools', 'cloud-infra finance commentary']`

#### Scenario: LLM failure leaves contract unchanged

- **GIVEN** a valid contract and an LLM endpoint returning malformed JSON twice in a row
- **WHEN** `reviseContract(...)` runs
- **THEN** `run_state.contract_json` is byte-identical to its pre-call state
- **AND** the in-process caches remain valid (no invalidation on failure path)
- **AND** one `contract.revised` event has been emitted with non-empty `error`

#### Scenario: Already-inserted facts are not retroactively dropped

- **GIVEN** the corpus contains 200 facts inserted before a contract revision
- **AND** the revision adds `recruiting tools` to `out_of_scope`
- **WHEN** `reviseContract(...)` completes
- **THEN** the `facts` table still contains all 200 facts
- **AND** subsequent NEW inserts pass through the updated relevance gate
