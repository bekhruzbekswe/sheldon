# event-log Specification (delta)

## MODIFIED Requirements

### Requirement: Kind taxonomy is enforced at compile time

The TypeScript type for `kind` SHALL be a closed union covering all event kinds emitted by every layer that has shipped, including: `'llm.fast' | 'llm.deep' | 'search.query' | 'scrape.fetch' | 'scrape.skip' | 'summary.write' | 'chunk.split' | 'embed.batch' | 'claim.extract' | 'fact.write' | 'fact.dedupe' | 'fact.dropped.irrelevant' | 'frontier.seed' | 'frontier.push' | 'frontier.dedupe' | 'frontier.pop' | 'frontier.done' | 'frontier.skip' | 'iteration.start' | 'iteration.end' | 'phase.transition' | 'run.start' | 'run.end' | 'cluster.computed' | 'section.written' | 'report.written' | 'resume.detected' | 'resume.applied' | 'source.classified' | 'contract.drafted'`. Emitting an unrecognized kind MUST fail type checking. The taxonomy MUST be extended through this module's source, not by callers.

The newly-added kinds in this delta are: `fact.dropped.irrelevant` (L3, emitted by `factStore.insert` when the relevance gate fires), `source.classified` (L3, emitted by `classifySource`), `contract.drafted` (L5, emitted by the contract drafter).

The dashboard / watch-CLI formatter (`format.ts`) MUST gain switch cases for each of the three new kinds. Each case produces a one-line human-readable summary from the event payload following the convention used by existing cases (e.g., `fact.write` shows `#<id> <claim>`; `source.classified` should show `<domain> · <sourceType> · <promotionalIntent>`).

#### Scenario: Unknown kind fails to type-check

- **WHEN** caller writes `events.emit({kind:'definitely-not-real', layer:'L0', payload:{}})`
- **THEN** `bun run typecheck` reports an error on that line

#### Scenario: New S1 kinds are accepted at compile time

- **WHEN** caller writes `events.emit({kind:'fact.dropped.irrelevant', layer:'L3', payload:{}})`, `events.emit({kind:'source.classified', layer:'L3', payload:{}})`, or `events.emit({kind:'contract.drafted', layer:'L5', payload:{}})`
- **THEN** `bun run typecheck` passes

#### Scenario: Formatter has cases for new kinds

- **GIVEN** an event of kind `source.classified` with payload `{domain:'unity-connect.com', sourceType:'vendor', promotionalIntent:'high', primaryVsDerivative:'derivative'}`
- **WHEN** `formatEvent(event)` runs
- **THEN** the returned string is non-empty and contains `'unity-connect.com'` and `'vendor'`
- **AND** the string is NOT the JSON fallback `JSON.stringify(payload).slice(0, 80)` (i.e., the default-case branch was not hit)

#### Scenario: New L7 kinds remain accepted (regression check)

- **WHEN** caller writes `events.emit({kind:'resume.applied', layer:'L7', payload:{}})` or `'resume.detected'`
- **THEN** `bun run typecheck` passes
