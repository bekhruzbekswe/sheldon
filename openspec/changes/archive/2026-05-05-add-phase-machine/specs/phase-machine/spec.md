## ADDED Requirements

### Requirement: Compute phase from wall-clock time

The `phaseMachine.now()` function SHALL return the current phase (`'breadth' | 'depth' | 'synthesis'`) based on `Date.now()` relative to the `started_at` and `deadline_at` of the active run. The phase boundaries default to 30% (breadth→depth) and 80% (depth→synthesis). Beyond `deadline_at` the phase is `'synthesis'`. With no active run, the function MUST throw.

#### Scenario: Within first 30% returns breadth

- **GIVEN** an active run with `started_at = T`, `deadline_at = T + 1000ms`
- **WHEN** `phaseMachine.now()` is called at `T + 100ms`
- **THEN** it returns `'breadth'`

#### Scenario: Between 30% and 80% returns depth

- **WHEN** `phaseMachine.now()` is called at `T + 500ms`
- **THEN** it returns `'depth'`

#### Scenario: After 80% returns synthesis

- **WHEN** `phaseMachine.now()` is called at `T + 850ms`
- **THEN** it returns `'synthesis'`

#### Scenario: After deadline returns synthesis

- **WHEN** `phaseMachine.now()` is called at `T + 1500ms`
- **THEN** it returns `'synthesis'`

### Requirement: Emit phase.transition events on first observation of each new phase

When `phaseMachine.now()` observes a transition (the in-memory cached previous phase differs from the newly computed one), it SHALL emit one `phase.transition` event with `layer:'L5'` and `payload` containing `from`, `to`, and `elapsedMs`. It MUST also persist the new phase to the `run_state` row.

#### Scenario: First crossing into depth emits one event

- **GIVEN** the cached previous phase is `'breadth'`
- **WHEN** `phaseMachine.now()` is called and computes `'depth'`
- **THEN** exactly one `phase.transition` event has been emitted with `payload.from = 'breadth'`, `payload.to = 'depth'`
- **AND** subsequent calls within the depth window do NOT emit duplicates

### Requirement: Parse deadline strings into absolute timestamps

The `parseDeadline(input, now)` function SHALL accept duration strings (`30s`, `90m`, `5h`, `500ms`) and ISO-8601 absolute timestamps. It MUST return a unix-ms timestamp greater than `now`. Inputs producing a deadline ≤ `now + 60_000` MUST throw with a message mentioning the minimum.

#### Scenario: Duration is added to now

- **WHEN** `parseDeadline('5h', T)` is called
- **THEN** the result equals `T + 5 * 3600 * 1000`

#### Scenario: ISO-8601 absolute timestamp

- **WHEN** `parseDeadline('2026-12-31T00:00:00Z', T)` is called and that's in the future
- **THEN** the result equals `Date.parse('2026-12-31T00:00:00Z')`

#### Scenario: Past deadline rejected

- **WHEN** `parseDeadline('-5h', T)` or any deadline in the past
- **THEN** the function throws with a message mentioning "past" or "future"

#### Scenario: Too-near deadline rejected

- **WHEN** `parseDeadline('30s', T)` is called
- **THEN** the function throws with a message mentioning "minimum" or "60s"
