## ADDED Requirements

### Requirement: Pop refuses to return a row in synthesis phase

The `frontier.pop()` function SHALL consult `phaseMachine.now()` (when an active run exists) before transitioning a row. If the current phase is `'synthesis'`, the function MUST return `null` without modifying any row, even if pending entries exist. Calls outside an active run (no `run_state` row) continue to behave as before.

#### Scenario: Synthesis phase locks pop

- **GIVEN** an active run whose phase is `'synthesis'` and pending rows exist
- **WHEN** `frontier.pop()` is called
- **THEN** the function returns `null`
- **AND** no row's status has been updated

#### Scenario: Pre-synthesis phase pops normally

- **GIVEN** an active run whose phase is `'breadth'` and pending rows exist
- **WHEN** `frontier.pop()` is called
- **THEN** the function returns the highest-scored pending row as before
