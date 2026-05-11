# source-classifier Specification

## Purpose

Per-domain source classifier. On first encounter of a scraped domain, ask the LLM to label its `source_type`, `promotional_intent`, and `primary_vs_derivative` once; cache the result forever in a `sources` table that survives `--fresh`. Doesn't drop sources — labels them so downstream stages (S2 thesis-driven section writers, S3 source-weighted scoring + diversity penalty) can hedge, weight, or de-emphasize content from over-promotional or derivative sources without re-classifying.

## Requirements

### Requirement: Persistent sources cache keyed by domain

The system SHALL persist a `sources` table in `.sheldon/sheldon.db` with columns `domain TEXT PRIMARY KEY, source_type TEXT, promotional_intent TEXT, primary_vs_derivative TEXT, classified_at INTEGER, raw_label_json TEXT`. The schema MUST be created idempotently in `getDb()`'s init block alongside the existing tables. The cache MUST survive `--fresh` (the modified `clearAll()` in the resume capability does not delete the `sources` table).

#### Scenario: Schema is created on first DB open

- **GIVEN** a freshly-created `.sheldon/sheldon.db`
- **WHEN** `getDb()` runs
- **THEN** the `sources` table exists with the documented columns

#### Scenario: Sources cache survives --fresh

- **GIVEN** the `sources` table contains a row for `domain = 'a16z.com'`
- **WHEN** `clearAll()` runs and a new run starts
- **THEN** the `sources` table still contains the row for `'a16z.com'`

### Requirement: Domain extraction from URL

The classifier SHALL derive a domain from a URL via `new URL(url).hostname`, lowercased, with a leading `www.` prefix stripped. No further normalization is performed: subdomains like `blog.acme.com` and `acme.com` count as different domains.

#### Scenario: www-stripped hostname is the cache key

- **WHEN** `lookupSource('https://www.unity-connect.com/some/page')` is called
- **THEN** the lookup is performed with `domain = 'unity-connect.com'`

#### Scenario: Subdomain is preserved

- **WHEN** `lookupSource('https://blog.acme.com/x')` is called
- **THEN** the lookup is performed with `domain = 'blog.acme.com'`
- **AND** a separate cache entry exists for `acme.com`

### Requirement: lookupSource returns null when unclassified

The `lookupSource(domain)` function SHALL return the cached classification row (or null when the domain has not yet been classified). It MUST NOT trigger an LLM call. It MUST NOT mutate state.

#### Scenario: Unclassified domain returns null

- **GIVEN** `'example.com'` has no row in `sources`
- **WHEN** `lookupSource('example.com')` is called
- **THEN** the return value is `null`
- **AND** no LLM call has been made

### Requirement: classifySource invokes the LLM and persists the result

The `classifySource(domain, sampleText)` function SHALL invoke `llm.fast` once with `response_format: json_schema`, retry-once on parse failure, and markdown-fence stripping as fallback (matching the project-wide structured-output pattern). On success, it MUST insert a `sources` row with `source_type ∈ {academic, regulator, analyst, vc-blog, trade-pub, vendor, personal-blog, forum, other}`, `promotional_intent ∈ {none, low, medium, high}`, `primary_vs_derivative ∈ {primary, derivative, mixed}`, `classified_at = Date.now()`, and the raw JSON response in `raw_label_json`. The function MUST emit one `source.classified` event with `layer:'L3'`, `durationMs`, and a payload containing `domain`, `sourceType`, `promotionalIntent`, `primaryVsDerivative`.

#### Scenario: Successful classification inserts row and emits event

- **GIVEN** the `sources` table has no row for `'unity-connect.com'`
- **WHEN** `classifySource('unity-connect.com', sampleText)` runs and the LLM returns `{source_type:'vendor', promotional_intent:'high', primary_vs_derivative:'derivative'}`
- **THEN** the `sources` table contains exactly one row for that domain with those values
- **AND** one `source.classified` event has been emitted

### Requirement: Persistent failure stores a default classification and caches the failure

If `classifySource` cannot obtain a parsable response after one retry, the function SHALL still insert a row with default values `{source_type:'other', promotional_intent:'medium', primary_vs_derivative:'mixed'}`, `raw_label_json = NULL`. This prevents repeated retry storms on the same broken-classifier domain. The emitted `source.classified` event MUST include an `error` field describing the failure.

#### Scenario: Repeated failures do not retry classification

- **GIVEN** the LLM returns malformed JSON for `'broken-domain.com'` twice in a row
- **WHEN** `classifySource('broken-domain.com', sampleText)` runs
- **THEN** the `sources` table contains a row for `'broken-domain.com'` with default values
- **AND** one `source.classified` event has been emitted with a non-empty `error` payload field
- **AND** subsequent `lookupSource('broken-domain.com')` calls return that defaulted row without invoking the LLM

### Requirement: Classification runs at most once per domain per process

When `indexSource` (in the search loop) processes a scrape, it SHALL call `lookupSource(domain)` first. If the row exists, no LLM call is made. If the row is missing, `classifySource(domain, sampleText)` is called once. Concurrent same-domain scrapes within one iteration MUST NOT trigger duplicate classification calls (idempotency is enforced by the table's PRIMARY KEY on domain).

#### Scenario: Already-classified domain triggers no LLM call

- **GIVEN** `lookupSource('a16z.com')` returns a non-null row
- **WHEN** `indexSource(scrape, ...)` processes a new URL on `'a16z.com'`
- **THEN** `classifySource` is not called for that domain
