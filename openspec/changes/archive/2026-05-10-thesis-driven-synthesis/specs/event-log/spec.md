# event-log Specification (delta)

## MODIFIED Requirements

### Requirement: Kind taxonomy is enforced at compile time

The TypeScript type for `kind` SHALL be a closed union covering all event kinds emitted by every layer that has shipped, including: `'llm.fast' | 'llm.deep' | 'search.query' | 'scrape.fetch' | 'scrape.skip' | 'source.classified' | 'summary.write' | 'chunk.split' | 'embed.batch' | 'claim.extract' | 'fact.write' | 'fact.dedupe' | 'fact.dropped.irrelevant' | 'frontier.seed' | 'frontier.push' | 'frontier.dedupe' | 'frontier.pop' | 'frontier.done' | 'frontier.skip' | 'iteration.start' | 'iteration.end' | 'phase.transition' | 'contract.drafted' | 'run.start' | 'run.end' | 'cluster.computed' | 'thesis.drafted' | 'claim.triangulated' | 'section.rubric' | 'section.written' | 'section.dropped' | 'synthesis.fallback' | 'report.written' | 'resume.detected' | 'resume.applied'`. Emitting an unrecognized kind MUST fail type checking. The taxonomy MUST be extended through this module's source, not by callers.

The newly-added kinds in this delta are: `thesis.drafted` (L6, emitted by the thesis-drafter), `claim.triangulated` (L6, emitted per claim by the claim-triangulator), `section.rubric` (L6, emitted by `evaluateSection`), `section.dropped` (L6, emitted by the synthesis orchestrator's brutal-editor pass), `synthesis.fallback` (L6, emitted by the synthesis orchestrator when the cluster path is taken).

The dashboard / watch-CLI formatter (`format.ts`) MUST gain switch cases for each of the five new kinds. Each case produces a one-line human-readable summary from the event payload following the convention used by existing cases (e.g., `thesis.drafted` shows `claims=N · slice=M · domains=K`; `claim.triangulated` shows `<headline> · +cor / -con · contested?`; `section.dropped` shows `<headline> · <rubric note>`; `synthesis.fallback` shows `reason · facts=N`).

#### Scenario: Unknown kind fails to type-check

- **WHEN** caller writes `events.emit({kind:'definitely-not-real', layer:'L0', payload:{}})`
- **THEN** `bun run typecheck` reports an error on that line

#### Scenario: New S2 kinds are accepted at compile time

- **WHEN** caller writes `events.emit({kind:'thesis.drafted', layer:'L6', payload:{}})`, `events.emit({kind:'claim.triangulated', layer:'L6', payload:{}})`, `events.emit({kind:'section.rubric', layer:'L6', payload:{}})`, `events.emit({kind:'section.dropped', layer:'L6', payload:{}})`, or `events.emit({kind:'synthesis.fallback', layer:'L6', payload:{}})`
- **THEN** `bun run typecheck` passes

#### Scenario: Formatter has cases for new kinds

- **GIVEN** an event of kind `claim.triangulated` with payload `{claimHeadline:'Wage Arbitrage Erosion', corroborations: 4, contradictions: 1, contested: false, queriesRan: 2}`
- **WHEN** `formatEvent(event)` runs
- **THEN** the returned string is non-empty and contains `'Wage Arbitrage Erosion'`
- **AND** the string is NOT the JSON fallback `JSON.stringify(payload).slice(0, 80)` (i.e., the default-case branch was not hit)

#### Scenario: Existing S1 kinds remain accepted (regression check)

- **WHEN** caller writes `events.emit({kind:'fact.dropped.irrelevant', layer:'L3', payload:{}})`, `'source.classified'`, or `'contract.drafted'`
- **THEN** `bun run typecheck` passes
