## MODIFIED Requirements

### Requirement: Kind taxonomy is enforced at compile time

The TypeScript type for `kind` SHALL be a closed union (e.g., `'llm.fast' | 'llm.deep' | 'search.query' | 'scrape.fetch' | 'scrape.skip' | 'summary.write' | …`) such that emitting an unrecognized kind fails type checking. The taxonomy MUST be extended through this module's source, not by callers.

#### Scenario: Unknown kind fails to type-check

- **WHEN** caller writes `events.emit({kind:'definitely-not-real', layer:'L0', payload:{}})`
- **THEN** `bun run typecheck` (i.e., `tsc --noEmit`) reports an error on that line

#### Scenario: New L2 kinds are accepted

- **WHEN** caller writes `events.emit({kind:'search.query', layer:'L2', payload:{}})` or any of `'scrape.fetch'`, `'scrape.skip'`, `'summary.write'`
- **THEN** `bun run typecheck` passes
