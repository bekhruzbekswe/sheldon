# claim-triangulator Specification

## Purpose

After the thesis-drafter identifies 4–7 load-bearing claims, the triangulator runs targeted SearXNG queries per claim to seek out independent corroboration and explicit contradiction. Newly-extracted facts flow through the standard fact-store ingestion path (relevance gate / dedupe / source classifier), and the triangulator computes per-claim metadata (`corroborations`, `contradictions`, `contested`) that the section-writer prompt consumes — sections then assert with confidence, hedge thin evidence, or explicitly flag contention. Budget-bounded so synthesis stays inside its wall-clock budget.

## Requirements

### Requirement: Triangulate each thesis claim with corroborate and contradict queries

The system SHALL run a triangulation pass over every thesis claim, executing two targeted SearXNG queries per claim:

- **Corroboration query**: `<claim_text> evidence data report`
- **Contradiction query**: `<claim_text> dispute criticism limitation`

For each query, the system SHALL fetch the top 3 SearXNG results, attempt to scrape each (using the existing `scraper.fetch` non-throwing path), chunk + extract claims from successful scrapes, and insert the resulting facts via `factStore.insert` (which routes through the relevance gate, dedupe, and source classifier as normal).

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

Triangulation SHALL enforce a **per-claim** wall-clock budget `PER_CLAIM_BUDGET_MS` defined as a per-file constant in `src/triangulate.ts`. Each thesis claim's triangulation runs against its own budget — the budgets do NOT aggregate or share across claims. Empirically tuned starting value: `180_000` (3 min). Originally specced at `60_000` (1 min); retuned after v2-tuning's smoke run showed 5 of 6 claims exceeded 60s on a slow-LLM day (durations 153s–504s). 180s catches the typical case while keeping total triangulation bounded.

Within a single claim's triangulation (`triangulateOne`), URL ingestion (scrape + chunk + extract + insert) for the 6 URLs returned by the two SearXNG queries SHALL run in parallel via `Promise.all`. Sequential ingestion is forbidden — it was the documented cause of the first claim consuming a full shared budget under the original flat-budget design (now removed).

Per-claim budget enforcement is a soft check after the parallel ingestion resolves. When elapsed > `PER_CLAIM_BUDGET_MS`, the function SHALL skip the corroboration scoring step, return defaults `{corroborations:0, contradictions:0, contested:false, queriesRan:2}`, and the orchestrator MUST emit `claim.triangulated` with `error: 'budget exceeded mid-claim'`. In-flight scrapes / extracts are NOT cancelled mid-execution; the cleanest exit point is between phases.

The legacy total-budget path (a flat `TRIANGULATION_BUDGET_MS` passed into `triangulateClaims`) is REMOVED. The function signature is `triangulateClaims(claims: ThesisClaim[]): Promise<ClaimTriangulation[]>` — no budget parameter.

#### Scenario: Per-claim budget independence

- **GIVEN** a thesis with 5 claims and a healthy LLM endpoint
- **WHEN** `triangulateClaims(claims)` runs to completion
- **THEN** all 5 claims get their `claim.triangulated` events with `queriesRan: 2`
- **AND** no event has `error: 'budget exceeded mid-claim'` so long as no individual claim takes more than `PER_CLAIM_BUDGET_MS`

#### Scenario: Slow first claim does not poison subsequent claims

- **GIVEN** claim 1's URL ingestion takes 90 seconds (e.g., a slow scrape + slow extract chain)
- **WHEN** `triangulateClaims(claims)` runs
- **THEN** claim 1 completes and emits its event (possibly with `error: 'budget exceeded mid-claim'` or a populated triangulation result depending on where the threshold is crossed)
- **AND** claim 2 starts fresh with its own per-claim budget
- **AND** claims 2..N each get a real chance at full triangulation

#### Scenario: URL ingestion runs in parallel within a claim

- **GIVEN** a thesis claim with 6 URLs to ingest from its corroboration + contradiction queries
- **WHEN** `triangulateOne(claim)` runs
- **THEN** the 6 `ingestUrl` calls run concurrently (via `Promise.all`)
- **AND** the wall-clock for the ingestion step is bounded by the slowest single URL, not by the sum

### Requirement: Triangulation results enter the main fact store

Facts extracted during triangulation SHALL pass through `factStore.insert` with the same relevance-gate / dedupe / source-classifier path as facts gathered during the main loop. They MUST receive a `topicTag` of `triangulation` so they're distinguishable in the corpus. Their `questionId` MUST be null (they're not associated with a frontier question).

#### Scenario: Triangulation facts are gate-checked

- **GIVEN** a triangulation query returns a clearly-off-topic page
- **WHEN** its claims are extracted and `factStore.insert` is called
- **THEN** the existing relevance gate may drop them (emitting `fact.dropped.irrelevant`)
- **AND** if dropped, those drops do NOT count toward this claim's corroborations or contradictions
