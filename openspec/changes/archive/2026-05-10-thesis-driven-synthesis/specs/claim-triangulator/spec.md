# claim-triangulator Specification (delta)

## ADDED Requirements

### Requirement: Triangulate each thesis claim with corroborate and contradict queries

The system SHALL run a triangulation pass over every thesis claim, executing two targeted SearXNG queries per claim:

- **Corroboration query**: `<claim_text> evidence data report`
- **Contradiction query**: `<claim_text> dispute criticism limitation`

For each query, the system SHALL fetch the top 3 SearXNG results, attempt to scrape each (using the existing `scraper.fetch` non-throwing path), chunk + extract claims from successful scrapes, and insert the resulting facts via `factStore.insert` (which routes through S1's relevance gate, dedupe, and source classifier as normal).

After ingestion, the system SHALL compute, for each thesis claim:

- `corroborations`: count of newly-inserted (or already-present) facts with `cosine(fact, claim) >= 0.55` whose 200-char source-text window contains NO disagreement markers.
- `contradictions`: count with `cosine(fact, claim) >= 0.55` whose 200-char window DOES contain disagreement markers.
- `contested`: boolean true when `contradictions >= 2 AND contradictions / (corroborations + contradictions) >= 0.30`.

Disagreement markers (per-file constant): `however`, `but`, `contrary`, `fails to`, `disputes`, `criticism`, `criticized`, `unlike`, `nevertheless`, `whereas`.

The triangulator MUST emit one `claim.triangulated` event per claim with `layer:'L6'`, `durationMs`, payload `{claimHeadline, corroborations, contradictions, contested, queriesRan}`.

#### Scenario: Triangulation runs both query variants per claim

- **GIVEN** a thesis with 5 claims
- **WHEN** triangulation runs to completion (no budget cap)
- **THEN** SearXNG receives exactly 10 queries (5 corroborate + 5 contradict)
- **AND** 5 `claim.triangulated` events have been emitted

#### Scenario: Contested flag fires on minority contradiction

- **GIVEN** a claim where triangulation found 5 corroborators and 3 contradictions
- **WHEN** the triangulator computes the contested flag
- **THEN** `contested === true` (3 contradictions, 3/(5+3)=0.375 ≥ 0.30)

#### Scenario: Single contradiction does not flip contested

- **GIVEN** a claim with 5 corroborators and 1 contradiction
- **WHEN** the contested flag is computed
- **THEN** `contested === false` (1 contradiction is below the threshold of 2)

### Requirement: Budget-bounded triangulation

Triangulation total wall-clock SHALL NOT exceed `min(120_000, 0.25 * remainingSynthesisBudgetMs)`. The orchestrator computes `remainingSynthesisBudgetMs` from `(deadlineAt - Date.now()) - estimatedRemainingNonTriangulationCost`. When the cap is reached, claims that haven't been triangulated yet receive default metadata `{corroborations: 0, contradictions: 0, contested: false}` and the section writer treats them with hedging (the existing thin-evidence path).

A `claim.triangulated` event with `error: 'budget exceeded'` SHALL be emitted for each skipped claim.

#### Scenario: Budget cap stops triangulation mid-pass

- **GIVEN** a thesis with 7 claims and a synthesis budget allowing only 4 triangulations
- **WHEN** the triangulator runs through the claims in order
- **THEN** 4 claims receive full triangulation
- **AND** 3 claims receive default metadata via budget-skip
- **AND** 3 `claim.triangulated` events with `error:'budget exceeded'` are present in the event log

### Requirement: Triangulation results enter the main fact store

Facts extracted during triangulation SHALL pass through `factStore.insert` with the same relevance-gate / dedupe / source-classifier path as facts gathered during the main loop. They MUST receive a `topicTag` of `triangulation` so they're distinguishable in the corpus. Their `questionId` MUST be null (they're not associated with a frontier question).

#### Scenario: Triangulation facts are gate-checked

- **GIVEN** a triangulation query returns a clearly-off-topic page
- **WHEN** its claims are extracted and `factStore.insert` is called
- **THEN** the existing relevance gate may drop them (emitting `fact.dropped.irrelevant`)
- **AND** if dropped, those drops do NOT count toward this claim's corroborations or contradictions
