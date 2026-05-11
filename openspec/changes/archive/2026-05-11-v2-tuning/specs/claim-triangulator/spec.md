# claim-triangulator Specification (delta)

## MODIFIED Requirements

### Requirement: Budget-bounded triangulation

Triangulation SHALL enforce a **per-claim** wall-clock budget `PER_CLAIM_BUDGET_MS` defined as a per-file constant in `src/triangulate.ts`. Each thesis claim's triangulation runs against its own budget — the budgets do NOT aggregate or share across claims. Empirically tuned starting value: `180_000` (3 min). Originally specced at `60_000` (1 min); retuned after v2-tuning's smoke run showed 5 of 6 claims exceeded 60s on a slow-LLM day (durations 153s–504s). 180s catches the typical case while keeping total triangulation bounded.

Within a single claim's triangulation (`triangulateOne`), URL ingestion (scrape + chunk + extract + insert) for the 6 URLs returned by the two SearXNG queries SHALL run in parallel via `Promise.all`. Sequential ingestion is forbidden — it was the documented cause of the first claim consuming a full shared budget.

Per-claim budget enforcement is a soft check at natural awaiting boundaries. When `Promise.all` of URL ingests resolves, if elapsed > `PER_CLAIM_BUDGET_MS` AND there are remaining downstream operations (corroboration scoring loop), the function MAY emit `claim.triangulated` with `error: 'budget exceeded mid-claim'` and return defaults `{corroborations:0, contradictions:0, contested:false, queriesRan:0}`. In-flight scrapes / extracts are NOT cancelled mid-execution; the cleanest exit point is between phases.

The legacy total-budget path (a flat `TRIANGULATION_BUDGET_MS` passed into `triangulateClaims`) is REMOVED. The orchestrator no longer computes or passes a global budget. The new function signature is `triangulateClaims(claims: ThesisClaim[]): Promise<ClaimTriangulation[]>` — no budget parameter.

#### Scenario: Per-claim budget independence

- **GIVEN** a thesis with 5 claims and a healthy LLM endpoint
- **WHEN** `triangulateClaims(claims)` runs to completion
- **THEN** all 5 claims get their `claim.triangulated` events with `queriesRan: 2`
- **AND** no event has `error: 'budget exceeded'` so long as no individual claim takes more than 60s

#### Scenario: Slow first claim does not poison subsequent claims

- **GIVEN** claim 1's URL ingestion takes 90 seconds (e.g., a slow scrape + slow extract chain)
- **WHEN** `triangulateClaims(claims)` runs
- **THEN** claim 1 completes and emits its event (possibly with `error: 'budget exceeded mid-claim'` or with a populated triangulation result depending on where the threshold is crossed)
- **AND** claim 2 starts fresh with its own 60s budget
- **AND** claims 2..N each get a real chance at full triangulation

#### Scenario: URL ingestion runs in parallel within a claim

- **GIVEN** a thesis claim with 6 URLs to ingest from its corroboration + contradiction queries
- **WHEN** `triangulateOne(claim)` runs
- **THEN** the 6 `ingestUrl` calls run concurrently (via `Promise.all`)
- **AND** the wall-clock for the ingestion step is bounded by the slowest single URL, not by the sum
