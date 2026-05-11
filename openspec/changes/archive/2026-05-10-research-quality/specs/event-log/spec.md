# event-log Specification (delta)

## MODIFIED Requirements

### Requirement: Kind taxonomy is enforced at compile time

The TypeScript type for `kind` SHALL be a closed union covering all event kinds emitted by every layer that has shipped, including: `'llm.fast' | 'llm.deep' | 'search.query' | 'scrape.fetch' | 'scrape.skip' | 'source.classified' | 'summary.write' | 'chunk.split' | 'embed.batch' | 'claim.extract' | 'fact.write' | 'fact.dedupe' | 'fact.dropped.irrelevant' | 'frontier.seed' | 'frontier.push' | 'frontier.dedupe' | 'frontier.pop' | 'frontier.done' | 'frontier.skip' | 'iteration.start' | 'iteration.end' | 'phase.transition' | 'gap.analyzed' | 'contract.drafted' | 'contract.revised' | 'run.start' | 'run.end' | 'cluster.computed' | 'thesis.drafted' | 'claim.triangulated' | 'section.rubric' | 'section.written' | 'section.dropped' | 'synthesis.fallback' | 'report.written' | 'resume.detected' | 'resume.applied'`. Emitting an unrecognized kind MUST fail type checking. The taxonomy MUST be extended through this module's source, not by callers.

The newly-added kinds in this delta are: `gap.analyzed` (L4, emitted by the gap-analyzer at each phase boundary) and `contract.revised` (L5, emitted by the contract module's `reviseContract` at each phase boundary).

The dashboard / watch-CLI formatter (`format.ts`) MUST gain switch cases for both. Each case produces a one-line human-readable summary from the event payload following the convention used by existing cases (e.g., `gap.analyzed` shows `<phaseTransition> · pushed=N · deduped=M`; `contract.revised` shows `<phaseTransition> · -X +Y` where X and Y are the counts of removed and added OOS items).

#### Scenario: Unknown kind fails to type-check

- **WHEN** caller writes `events.emit({kind:'definitely-not-real', layer:'L0', payload:{}})`
- **THEN** `bun run typecheck` reports an error on that line

#### Scenario: New S3 kinds are accepted at compile time

- **WHEN** caller writes `events.emit({kind:'gap.analyzed', layer:'L4', payload:{}})` or `events.emit({kind:'contract.revised', layer:'L5', payload:{}})`
- **THEN** `bun run typecheck` passes

#### Scenario: Formatter has cases for S3 kinds

- **GIVEN** an event of kind `gap.analyzed` with payload `{phaseTransition: 'breadth->depth', gapsProposed: 4, gapsPushed: 3, gapsDeduped: 1}`
- **WHEN** `formatEvent(event)` runs
- **THEN** the returned string is non-empty and contains `'breadth->depth'`
- **AND** the string is NOT the JSON fallback `JSON.stringify(payload).slice(0, 80)` (i.e., the default-case branch was not hit)

#### Scenario: Existing S2 kinds remain accepted (regression check)

- **WHEN** caller writes `events.emit({kind:'thesis.drafted', layer:'L6', payload:{}})`, `'claim.triangulated'`, `'section.rubric'`, `'section.dropped'`, or `'synthesis.fallback'`
- **THEN** `bun run typecheck` passes
