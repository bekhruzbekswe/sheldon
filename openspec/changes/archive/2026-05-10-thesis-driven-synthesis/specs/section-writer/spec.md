# section-writer Specification (delta)

## ADDED Requirements

### Requirement: writeSectionFromClaim defends a specific claim using ranked evidence

The `writeSectionFromClaim(input, ctx)` function SHALL accept:

```ts
{
  claim: string,                  // the one-sentence claim to defend
  headline: string,               // the H2 heading (3-8 plain English words)
  rankedFacts: SectionFact[],     // top-K facts pre-sorted; index 0 is most load-bearing
  triangulation: {
    corroborations: number,
    contradictions: number,
    contested: boolean,
  }
}
```

…and a context `{originalTask}`, and return `{label: headline, body, factIds: number[], usedLocalIds: number[]}` (matching the existing `Section` shape so the stitcher consumes both functions identically).

The system prompt SHALL instruct the model to:

1. **Open** with a single thesis sentence asserting the *claim*. Do NOT hedge or qualify in the opening unless triangulation says so.
2. **Body** must rank the supporting facts by importance — most load-bearing first. The `rankedFacts` array is already sorted; the prose ordering should follow it.
3. **Cite** every factual claim with `[N]` matching `localId`. The fact-numbering rules from S1 (filter out-of-range citations, retry-once on empty body) carry forward.
4. **Triangulation directives**:
   - If `corroborations >= 2 AND !contested`: assert the claim with normal confidence.
   - If `corroborations < 2 OR rankedFacts.length < 3`: hedge ("Evidence is thin, but…", "One source argues…").
   - If `contested === true`: explicitly surface the contention ("Sources disagree: X argues …, while Y reports …") and cite both sides.
5. **Drop weak facts**: if a fact in `rankedFacts` doesn't actually support the claim on inspection, the model is instructed to OMIT it rather than paraphrase it.
6. **No closing transitional sentence**. No "Furthermore"/"Consequently"/"Ultimately" as paragraph openers. (Same as the S1 rule; carried into the new function.)

The function MUST use `llm.fast` (no thinking). It MUST follow the existing two-attempt + filter-citations + word-count pattern from `writeSection`. It MUST emit one `section.written` event on completion (same shape as the existing function).

The legacy `writeSection(input, ctx)` function MUST remain in place for the cluster-fallback path. Its behaviour is unchanged.

#### Scenario: Confident assertion when triangulation supports it

- **GIVEN** triangulation `{corroborations: 4, contradictions: 0, contested: false}` and 8 ranked facts
- **WHEN** `writeSectionFromClaim(...)` returns a body
- **THEN** the body's first sentence asserts the claim without hedging language
- **AND** the body does not contain "Evidence is thin"

#### Scenario: Contested claim is explicitly flagged

- **GIVEN** triangulation `{corroborations: 3, contradictions: 3, contested: true}`
- **WHEN** `writeSectionFromClaim(...)` returns a body
- **THEN** the body contains explicit language acknowledging contention (e.g., "Sources disagree", "is contested", "challenges this view")
- **AND** facts are cited from both sides where possible

#### Scenario: Thin evidence forces hedging

- **GIVEN** `rankedFacts.length === 2` and `corroborations === 1`
- **WHEN** `writeSectionFromClaim(...)` returns a body
- **THEN** the body opens or contains a hedging phrase: "Evidence is thin", "One source argues", "Only one analyst reports", or similar
