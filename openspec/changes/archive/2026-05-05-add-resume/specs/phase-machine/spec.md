## ADDED Requirements

### Requirement: Allow seeding the phase-machine cache from disk

The phase-machine module SHALL expose a `seedPhaseCache(phase)` function that sets the in-memory `lastSeenPhase` to the given value without firing a `phase.transition` event. This is for the resume path: after re-reading a persisted `run_state.phase`, the cache must reflect the prior reality so the first `phaseMachine.now()` call after resume doesn't emit a spurious transition from `'breadth'` (the default cache state).

#### Scenario: Seed prevents spurious transition

- **GIVEN** a fresh process with `lastSeenPhase = null` and persisted `run_state.phase = 'depth'`
- **WHEN** `seedPhaseCache('depth')` is called, then `phaseMachine.now()` returns `'depth'` (live)
- **THEN** no `phase.transition` event has been emitted

#### Scenario: Seed does not lock cache; subsequent transitions still emit

- **GIVEN** `seedPhaseCache('depth')` has been called
- **WHEN** time advances and `phaseMachine.now()` returns `'synthesis'`
- **THEN** one `phase.transition` event with `from='depth'` and `to='synthesis'` is emitted
