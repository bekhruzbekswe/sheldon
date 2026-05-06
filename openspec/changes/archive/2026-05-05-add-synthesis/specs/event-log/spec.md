## MODIFIED Requirements

### Requirement: Kind taxonomy is enforced at compile time

The TypeScript type for `kind` SHALL be a closed union covering all event kinds emitted by every layer that has shipped, including: `'llm.fast' | 'llm.deep' | 'search.query' | 'scrape.fetch' | 'scrape.skip' | 'summary.write' | 'chunk.split' | 'embed.batch' | 'claim.extract' | 'fact.write' | 'fact.dedupe' | 'frontier.seed' | 'frontier.push' | 'frontier.dedupe' | 'frontier.pop' | 'frontier.done' | 'frontier.skip' | 'iteration.start' | 'iteration.end' | 'phase.transition' | 'run.start' | 'run.end' | 'cluster.computed' | 'section.written' | 'report.written'`. Emitting an unrecognized kind MUST fail type checking. The taxonomy MUST be extended through this module's source, not by callers.

#### Scenario: Unknown kind fails to type-check

- **WHEN** caller writes `events.emit({kind:'definitely-not-real', layer:'L0', payload:{}})`
- **THEN** `bun run typecheck` reports an error on that line

#### Scenario: New L6 kinds are accepted

- **WHEN** caller writes `events.emit({kind:'cluster.computed', layer:'L6', payload:{}})` or `'section.written'`, `'report.written'`
- **THEN** `bun run typecheck` passes
