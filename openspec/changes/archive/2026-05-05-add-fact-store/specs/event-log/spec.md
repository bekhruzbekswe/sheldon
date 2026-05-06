## MODIFIED Requirements

### Requirement: Kind taxonomy is enforced at compile time

The TypeScript type for `kind` SHALL be a closed union covering all event kinds emitted by every layer that has shipped, including: `'llm.fast' | 'llm.deep' | 'search.query' | 'scrape.fetch' | 'scrape.skip' | 'summary.write' | 'chunk.split' | 'embed.batch' | 'claim.extract' | 'fact.write' | 'fact.dedupe'`. Emitting an unrecognized kind MUST fail type checking. The taxonomy MUST be extended through this module's source, not by callers.

#### Scenario: Unknown kind fails to type-check

- **WHEN** caller writes `events.emit({kind:'definitely-not-real', layer:'L0', payload:{}})`
- **THEN** `bun run typecheck` (i.e., `tsc --noEmit`) reports an error on that line

#### Scenario: New L3 kinds are accepted

- **WHEN** caller writes `events.emit({kind:'fact.write', layer:'L3', payload:{}})` or any of `'chunk.split'`, `'embed.batch'`, `'claim.extract'`, `'fact.dedupe'`
- **THEN** `bun run typecheck` passes
