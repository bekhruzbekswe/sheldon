# section-writer Specification

## Purpose

LLM-driven prose generators for synthesis. `writeSection` takes one cluster's facts (numbered 1..N as local citations) and produces a 200–500 word Markdown body with `[N]` citations matching localId. `writeIntro` and `writeOutro` see only section labels (not bodies) and produce framing paragraphs with no citations. Filters out-of-range citations and retries once on empty/failed responses. Currently uses `llm.fast` (no thinking) — Qwen3.5-9B in deep mode unreliably consumes its full output budget on `reasoning_content`, leaving no tokens for actual content.

## Requirements
### Requirement: Write one report section per cluster using llm.fast

The `writeSection(cluster, ctx)` function SHALL accept a labeled cluster (with its facts inlined as `{localId, claim, sourceUrl, sourceTitle, confidence}`) and a context `{originalTask, sectionLabel}`, call `llm.fast` with a system prompt instructing 200–500-word output with `[N]` citations matching `localId`, and return `{label, body, usedLocalIds}`. The function MUST use `llm.fast` (no thinking).

Background: synthesis was originally specified to use `llm.deep` for quality. Empirically, Qwen3.5-9B in thinking mode at this prompt complexity (12+ facts of input, 200–500 word output) consumes its entire output budget on `reasoning_content` and returns zero content tokens. We accept slightly less polished prose in exchange for reliability. If quality becomes a felt problem, see the spec's "Future quality enhancements" requirement for the path forward.

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

The `writeIntro(task, sectionLabels, runStats)` and `writeOutro(task, sectionLabels, runStats)` functions SHALL each call `llm.fast` with only the original task and the list of section labels (NOT the section bodies) and produce a 1–2 paragraph intro/outro string. Both MUST avoid making any factual claim that wasn't surfaced in a section (the rule is enforced by the prompt — no citations are required because intros/outros are framing only).

#### Scenario: Intro and outro return non-empty paragraphs

- **WHEN** `writeIntro('What is RAG?', ['retrieval-mechanisms', 'vector-databases'], runStats)` resolves
- **THEN** the result is a non-empty string

### Requirement: Emit one section.written event per call

`writeSection` SHALL emit one `section.written` event on completion with `layer:'L6'`, `durationMs`, and `payload` containing `label`, `wordCount`, `citationCount`, `factCount` (input cluster size).

#### Scenario: section.written event populated

- **WHEN** `writeSection(...)` returns a body with 380 words and 9 distinct citations
- **THEN** one `section.written` event has been emitted with payload `{label, wordCount: 380, citationCount: 9, factCount}`

### Requirement: Future quality enhancements (informational)

If the prose quality of `llm.fast`-generated sections is judged insufficient for a given use case, the following enhancements MAY be considered as future work. They are documented here so the trade-off is known and the upgrade paths are obvious. This requirement is intentionally informational — implementations SHALL NOT be required to provide any of the enhancements below to conform to this spec.

1. **Streaming responses.** llama.cpp supports SSE streaming over OpenAI's `/v1/chat/completions` endpoint. Streaming bypasses Cloudflare's edge timeout (the connection stays "live" because bytes flow), which would let us re-enable `llm.deep` with much higher `max_tokens` (8000+). Implementation cost: a streaming variant of `LlmClient.dispatch`, propagated through `writeSection`. Estimated 1–2 day change.
2. **Two-pass synthesis.** Generate every section with `llm.fast` (today's behavior), then run a `llm.deep` polish pass over the stitched draft asking only for prose improvements without changing facts or citations. Polish takes one or two deep calls over the full report rather than per-section, which keeps each call short and side-steps the budget trap.
3. **Larger / better local model.** Qwen3.5-12B-Q5 or a Mistral-derived model in deep mode may behave better than Qwen3.5-9B at this prompt shape. Tradeoff: bigger memory footprint, fewer competing apps.
4. **Different embedding model + smaller clusters.** Switch to `mxbai-embed-large` (1024-dim) for tighter clusters with fewer facts each, reducing per-section prompt size and giving deep mode breathing room.
5. **Deeper claim extraction in L3.** Higher-quality extracted claims would mean less "interpretive lift" needed at synthesis time, narrowing the gap between fast-mode and deep-mode output.

#### Scenario: This requirement is purely informational

- **WHEN** an implementation conforms to all other requirements above
- **THEN** none of the enhancements listed here are required for conformance
- **AND** they MAY be implemented in a future change without breaking existing callers

