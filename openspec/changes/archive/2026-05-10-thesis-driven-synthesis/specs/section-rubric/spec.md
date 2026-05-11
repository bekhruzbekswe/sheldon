# section-rubric Specification (delta)

## ADDED Requirements

### Requirement: Evaluate a written section against a structural rubric

The system SHALL provide an `evaluateSection(section, claim)` function in `src/rubric.ts` that takes a written section body and the claim it was supposed to defend, and returns:

```json
{
  "has_mechanism": true|false,
  "has_example": true|false,
  "has_quantification": true|false,
  "defends_heading": true|false,
  "note": "string (one short line, REQUIRED on a fail, MAY be empty on full pass)"
}
```

The rubric is computed via one `llm.fast` call with `response_format: json_schema`, retry-once, markdown-fence-strip fallback. The system prompt SHALL instruct the model to:

- `has_mechanism`: does the section explain *how* something happens (a causal mechanism, not just a list of facts)?
- `has_example`: does the section name at least one concrete example, case study, named entity, or specific situation?
- `has_quantification`: does the section contain at least one quantitative signal (`%`, `$`, `n=`, a year, a count)?
- `defends_heading`: is the section body a defence of the heading's claim, or does it drift into adjacent material?
- `note`: when any field is `false`, give one short line explaining the most important failure (used as feedback for revision).

The function MUST emit one `section.rubric` event with `layer:'L6'`, `durationMs`, payload `{headline, has_mechanism, has_example, has_quantification, defends_heading}`.

#### Scenario: All fields populated for a thorough section

- **GIVEN** a section about *"FTE-based pricing collapse"* containing the line `"In Q3 2025, TCS reported a 12% drop in FTE-billed revenue"`
- **WHEN** `evaluateSection(body, claim)` runs
- **THEN** the returned object has `has_mechanism === true`, `has_example === true`, `has_quantification === true`, `defends_heading === true`
- **AND** one `section.rubric` event has been emitted

#### Scenario: Missing example flagged

- **GIVEN** a section that asserts a general trend with no named company, no specific date, no case
- **WHEN** the rubric runs
- **THEN** `has_example === false`
- **AND** the `note` field is non-empty and references the missing example

### Requirement: Rubric returns conservative defaults on LLM failure

If the rubric LLM call fails after retry, the function SHALL return `{has_mechanism: true, has_example: true, has_quantification: true, defends_heading: true, note: 'rubric LLM failed; pass-by-default'}`. This deliberately fails-open: a broken rubric must not delete legitimate sections.

The emitted `section.rubric` event MUST include an `error` field describing the failure.

#### Scenario: LLM failure does not drop sections

- **GIVEN** the LLM endpoint returns malformed JSON twice in a row
- **WHEN** `evaluateSection(body, claim)` is called
- **THEN** all four boolean fields are `true`
- **AND** the brutal-editor pass treats this section as passing
- **AND** one `section.rubric` event with non-empty `error` field is in the event log
