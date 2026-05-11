# followup-proposer Specification

## Purpose

LLM-driven follow-up generator. Given the original research task, the question just answered, recent claims, and what's already pending, proposes 3-5 next-step sub-questions with relevance scores in [0,1]. Caps prompt input (≤10 claims, ≤5 pending titles, ≤200 chars per claim) so token usage stays bounded. Uses `llm.fast` with JSON-schema response_format. Returns `[]` on persistent malformed responses.

## Requirements
### Requirement: Propose follow-up questions from task-relevant claims

The `proposer.propose(ctx)` function SHALL accept `{originalTask, parentQuestion, taskRelevantClaims, pendingTitles, saturatedDomains?}` and return 3–5 `{question, relevance, why}` entries. `relevance` MUST be in `[0, 1]`. `why` is a one-line debug string explaining the proposal. The function MUST use `llm.fast` with a JSON-schema `responseFormat`.

The input field `taskRelevantClaims` REPLACES the legacy `recentClaims` field. Caller (`research.ts`) is responsible for constructing this slice via `factStore.findSimilar(taskEmbedding, {topK: RECENT_CLAIMS_FOR_PROPOSER * 2})` followed by a per-domain cap (max 2 per domain) trim to `RECENT_CLAIMS_FOR_PROPOSER` entries. This is the load-bearing fresh-bias fix from S3: the proposer no longer reinforces whichever domain was *just* scraped, because the slice is anchored on task-cosine relevance and source-diversified.

If `getTaskEmbedding()` returns null (e.g., contract drafting failed early in the run), `research.ts` SHALL fall back to the legacy recency-sorted slice (`factStore.list({limit: RECENT_CLAIMS_FOR_PROPOSER})`). The proposer's prompt itself doesn't change in the fallback path — it just receives a different slice content.

The optional `saturatedDomains: string[]` field carries the run's currently over-represented domains (≥40% share OR >5 facts). When non-empty, the proposer's prompt includes a `<saturated_domains>` block listing them, and the system prompt instructs the model to bias toward questions likely to surface DIFFERENT sources. Saturated domains are a hint, not a hard filter.

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

### Requirement: Recent claims and pending titles bound input size

The proposer SHALL accept at most 10 recent claims (caller-truncated) and at most 5 pending frontier titles. The prompt MUST stay under 3000 input tokens regardless of claim length (longer claims get truncated to ≤200 chars each).

#### Scenario: Long claims are truncated in prompt

- **GIVEN** a recentClaims array where some entries exceed 500 characters
- **WHEN** `proposer.propose({...})` runs
- **THEN** the upstream LLM request body's user message contains each claim truncated to ≤200 chars

### Requirement: Survive malformed JSON with one retry

If the LLM returns malformed JSON, the proposer SHALL retry once. On persistent failure it MUST emit a `claim.extract` (semantic relative — same retry-then-empty pattern) — actually emit no extra event beyond the existing `iteration.end` and return `[]`.

Note: the proposer SHALL NOT emit a kind of its own; the caller is responsible for closing the iteration with `iteration.end` reflecting `proposalCount`.

#### Scenario: Persistent malformed JSON returns empty

- **GIVEN** the LLM returns malformed JSON twice in a row
- **WHEN** `proposer.propose(...)` runs
- **THEN** the function returns `[]`
- **AND** the function does not throw

