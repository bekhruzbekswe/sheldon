# research-contract Specification (delta)

## ADDED Requirements

### Requirement: Revise the contract's out_of_scope at phase boundaries

The system SHALL provide a `reviseContract(facts, currentContract)` function in `src/contract.ts` invoked once at each phase boundary by the synthesis-orchestrator (alongside the gap-analyzer). On each call:

1. `llm.fast` is invoked with the project-wide structured-output pattern (`response_format: json_schema`, retry-once, markdown-fence strip).
2. The prompt receives the current contract (especially `core_question` and current `out_of_scope`), a sample of facts the relevance gate dropped (so the LLM can see what was rejected and why), and a sample of repeated-but-borderline claims that snuck through the gate.
3. The LLM returns a revised `out_of_scope` array (3-5 items, full replacement). The prompt instructs the model to KEEP existing items unless the gathered facts have proven them irrelevant (i.e., legitimate adjacent content was being rejected) and to ADD new items only for adjacencies that consistently slipped through and turned out to be off-topic.
4. The returned `out_of_scope` array is persisted by writing the updated full contract JSON to `run_state.contract_json` via `getDb()`.
5. The in-process `oosEmbCache` is invalidated. The next call to `getOutOfScopeEmbeddings()` re-embeds with the new items.
6. Past inserted facts are NOT retroactively re-gated. The relevance gate runs only on new inserts.

The function MUST emit one `contract.revised` event with `layer: 'L5'`, `durationMs`, payload `{phaseTransition, oosBefore: string[], oosAfter: string[], removed: string[], added: string[], error?}`.

If the LLM call fails after retry or returns malformed JSON, the function SHALL leave the contract unchanged and emit `contract.revised` with `error` populated. The run continues.

#### Scenario: Successful revision updates contract_json and invalidates cache

- **GIVEN** a contract with `out_of_scope: ['API monitoring dashboards', 'p95 latency alerting']`
- **WHEN** `reviseContract(facts, contract)` is called and the LLM returns a revised `['p95 latency alerting', 'recruiting tools', 'cloud-infra finance commentary']`
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
