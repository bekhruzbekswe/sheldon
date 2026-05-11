# gap-analyzer Specification (delta)

## ADDED Requirements

### Requirement: Run a "what's missing?" pass at phase boundaries

The system SHALL provide a `gap-analyzer` capability invoked once at each phase transition during a research run. Trigger points:

1. **breadth → depth** (around 30% of the deadline): always runs.
2. **depth → synthesis** (around 80% of the deadline): runs *unless* the synthesis lock has already engaged (`frontier.pop()` returns null) — checked by the orchestrator before invoking.

At each boundary, the analyzer MUST:

1. Read the run state via `getRunState()` and the contract via `getContract()`.
2. Sample ~`GAP_SLICE_SIZE = 40` facts via task-relevance-sorted, source-diverse selection (cap `GAP_MAX_PER_DOMAIN = 3`). Selection logic mirrors the thesis-drafter's `selectSlice` shape.
3. Call `llm.fast` with the structured-output pattern (`response_format: json_schema`, retry-once, markdown-fence strip) on a prompt that includes `<core_question>`, `<sub_questions>`, `<good_answer_contains>`, `<out_of_scope>`, and the `<facts>` slice.
4. Parse the response into 3–5 `{question, relevance, why}` entries. `relevance` MUST be in `[0, 1]`.
5. For each entry: embed the question, push to the frontier with `score = score({relevance, novelty, depth: 0, phase: currentPhase()})` and `parentId: undefined`. Frontier dedupe (cosine ≥ 0.85) applies as normal.
6. Emit one `gap.analyzed` event with `layer: 'L4'`, `durationMs`, payload `{phaseTransition: 'breadth->depth' | 'depth->synthesis', gapsProposed, gapsPushed, gapsDeduped, error?}`.

If the LLM call fails after retry or returns fewer than 1 valid gap, the gap-analyzer SHALL return without pushing anything and emit `gap.analyzed` with a non-empty `error` payload field. The run continues without gap injection.

#### Scenario: Gap analysis pushes new seed questions at breadth→depth

- **GIVEN** a run that has just transitioned from breadth to depth phase with 60 facts in the corpus
- **WHEN** the orchestrator invokes the gap-analyzer
- **THEN** at most one `gap.analyzed` event is emitted with `phaseTransition: 'breadth->depth'`
- **AND** between 1 and 5 new seed questions have been pushed to the frontier with depth=0
- **AND** the count in the event's `gapsPushed` matches the actual frontier additions (excluding deduped)

#### Scenario: Gap analyzer fails gracefully on LLM error

- **GIVEN** the LLM endpoint returns malformed JSON twice in a row at the breadth→depth transition
- **WHEN** the gap-analyzer runs
- **THEN** zero new frontier rows are added by this call
- **AND** one `gap.analyzed` event is emitted with non-empty `error`
- **AND** `runResearch` continues into the depth phase

#### Scenario: Synthesis-already-engaged skips the depth→synthesis boundary call

- **GIVEN** a run where the depth phase ran out of iteration budget early and `frontier.pop()` already returns null due to synthesis lock
- **WHEN** the orchestrator's boundary hook fires
- **THEN** the gap-analyzer is NOT invoked for the depth→synthesis transition
- **AND** no `gap.analyzed` event with `phaseTransition: 'depth->synthesis'` is emitted

### Requirement: Gap-analyzer prompt requires concrete searchable angles

The system prompt SHALL instruct the LLM to:

- Identify angles relevant to the original task that are *not yet covered* by the gathered facts.
- Each gap MUST be a concrete, searchable question — something a search engine could meaningfully answer. Generic meta ("more case studies", "deeper analysis") is FORBIDDEN.
- Each gap MUST be substantive and specific. Examples of acceptable gaps for a question on outsourcing pain points: "How is TCS's outcome-based pricing structured for AI work?", "What is the GCC adoption rate among Fortune 500 companies in 2025?".
- DO NOT restate the contract's existing `sub_questions` — the goal is to surface what's MISSING.
- Each gap has a `relevance` in `[0, 1]` reflecting how central it is to the original task.
- The `why` field is one-line, explaining what's currently absent that justifies the new question.

#### Scenario: Generic meta-questions are not produced

- **WHEN** `gap.analyze(...)` returns its response
- **THEN** no entry's `question` field is "What other angles should we explore?" or similar generic meta-text
- **AND** every `question` is searchable (concrete subject + specific angle)
