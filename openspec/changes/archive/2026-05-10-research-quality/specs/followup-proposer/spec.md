# followup-proposer Specification (delta)

## MODIFIED Requirements

### Requirement: Propose follow-up questions from recent claims

The `proposer.propose(ctx)` function SHALL accept `{originalTask, parentQuestion, taskRelevantClaims, pendingTitles, saturatedDomains}` and return 3–5 `{question, relevance, why}` entries. `relevance` MUST be in `[0, 1]`. `why` is a one-line debug string explaining the proposal. The function MUST use `llm.fast` with a JSON-schema `responseFormat`.

The input field `taskRelevantClaims` REPLACES the legacy `recentClaims` field. Caller (`research.ts`) is responsible for constructing this slice via `factStore.findSimilar(taskEmbedding, {topK: RECENT_CLAIMS_FOR_PROPOSER * 2})` followed by a per-domain cap (max 2 per domain) trim to `RECENT_CLAIMS_FOR_PROPOSER` entries. This is the load-bearing fresh-bias fix: the proposer no longer reinforces whichever domain was *just* scraped, because the slice is anchored on task-cosine relevance and source-diversified.

If `getTaskEmbedding()` returns null (e.g., contract drafting failed early in the run), `research.ts` SHALL fall back to the legacy recency-sorted slice (`factStore.list({limit: RECENT_CLAIMS_FOR_PROPOSER})`). The proposer's prompt itself doesn't change in the fallback path — it just receives a different slice content.

The new optional `saturatedDomains: string[]` field carries the run's currently over-represented domains (≥40% share OR >5 facts). When non-empty, the proposer's prompt includes a `<saturated_domains>` block listing them, and the system prompt instructs the model to bias toward questions likely to surface DIFFERENT sources. Saturated domains are a hint, not a hard filter.

#### Scenario: Returns 3-5 follow-ups

- **GIVEN** a parent question and 8 task-relevant claims about EU AI Act
- **WHEN** `proposer.propose({...})` resolves
- **THEN** the result has between 3 and 5 entries
- **AND** every entry's `relevance` is in `[0, 1]`

#### Scenario: Slice is task-relevance-sampled, not recency-sorted

- **GIVEN** a fact store where the 10 most recent inserts are all from `a16z.com` and the 16 most task-relevant facts span 8 different domains
- **WHEN** `research.ts` constructs the proposer's `taskRelevantClaims` slice
- **THEN** the slice contains at most 2 facts from `a16z.com`
- **AND** the slice's content is dominated by task-cosine relevance, not by `created_at` order

#### Scenario: Saturated-domains hint reaches the prompt

- **GIVEN** a corpus where `a16z.com` accounts for 47% of facts
- **WHEN** `proposer.propose({...saturatedDomains: ['a16z.com']})` builds its user message
- **THEN** the user message contains a `<saturated_domains>` block listing `a16z.com`
- **AND** the system prompt mentions biasing toward questions likely to surface different sources

#### Scenario: Empty saturated-domains skips the hint block

- **GIVEN** no domain has yet crossed the saturation threshold
- **WHEN** `proposer.propose({...saturatedDomains: []})` builds its user message
- **THEN** the user message does NOT contain a `<saturated_domains>` block
- **AND** the system prompt instructions remain valid (the model isn't told to bias against an empty list)
