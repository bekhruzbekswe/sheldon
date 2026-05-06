## ADDED Requirements

### Requirement: Write one report section per cluster using llm.deep

The `writeSection(cluster, ctx)` function SHALL accept a labeled cluster (with its facts inlined as `{localId, claim, sourceUrl, sourceTitle, confidence}`) and a context `{originalTask, sectionLabel}`, call `llm.deep` with a system prompt instructing 200–500-word output with `[N]` citations matching `localId`, and return `{label, body, usedLocalIds}`. The function MUST use `llm.deep` (thinking on) — synthesis is the rare quality-critical place where we spend tokens.

#### Scenario: Returns body with section title and citations

- **GIVEN** a cluster of 20 facts with localIds 1..20
- **WHEN** `writeSection(cluster, ctx)` resolves
- **THEN** the returned object has `label`, `body`, and `usedLocalIds` (subset of 1..20)
- **AND** `body` contains at least one `[N]` citation matching a `usedLocalIds` entry

### Requirement: Forbid fabrication and citation outside provided facts

The system prompt SHALL explicitly instruct the model to (a) never assert anything not supported by the provided facts, (b) cite every claim with a local `[N]` matching the provided fact's `localId`, (c) note disagreements when sources contradict and cite both. Citations to unknown numbers (outside 1..N) MUST be filtered out before returning.

#### Scenario: Out-of-range citation is filtered

- **GIVEN** a cluster of 5 facts (localIds 1..5)
- **WHEN** the LLM returns text containing `[7]` (an out-of-range citation)
- **THEN** the returned `body` no longer contains `[7]`
- **AND** the returned `usedLocalIds` does not contain `7`

### Requirement: Write intro and outro from section headings

The `writeIntro(task, sectionLabels, runStats)` and `writeOutro(task, sectionLabels, runStats)` functions SHALL each call `llm.deep` with only the original task and the list of section labels (NOT the section bodies) and produce a 1–2 paragraph intro/outro string. Both MUST avoid making any factual claim that wasn't surfaced in a section (the rule is enforced by the prompt — no citations are required because intros/outros are framing only).

#### Scenario: Intro and outro return non-empty paragraphs

- **WHEN** `writeIntro('What is RAG?', ['retrieval-mechanisms', 'vector-databases'], runStats)` resolves
- **THEN** the result is a non-empty string

### Requirement: Emit one section.written event per call

`writeSection` SHALL emit one `section.written` event on completion with `layer:'L6'`, `durationMs`, and `payload` containing `label`, `wordCount`, `citationCount`, `factCount` (input cluster size).

#### Scenario: section.written event populated

- **WHEN** `writeSection(...)` returns a body with 380 words and 9 distinct citations
- **THEN** one `section.written` event has been emitted with payload `{label, wordCount: 380, citationCount: 9, factCount}`
