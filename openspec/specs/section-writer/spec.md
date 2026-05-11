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

### Requirement: System prompt requires ranked thesis-led prose without transitional padding

The `SECTION_SYSTEM_PROMPT` used by `writeSection` SHALL instruct the model to:

1. **Open** with a single thesis sentence stating the section's claim. (Replaces the prior "framing" instruction.)
2. **Body** must rank the supporting points by importance — most-load-bearing first.
3. **Acknowledge contradictions** explicitly when sources disagree, citing both sides.
4. **Hedge thin evidence**: when a claim is supported by fewer than 3 distinct facts or only one source, the prose MUST hedge ("Evidence is thin, but…" / "One source argues…") rather than asserting confidently.
5. **Omit weakly-supported claims** entirely rather than paraphrasing weak evidence.
6. **No closing transitional sentence**. The section ends on the body's final point, not on a meta-summary.
7. The words `"Furthermore"`, `"Consequently"`, and `"Ultimately"` MUST NOT appear as the *first word* of any closing paragraph. (They MAY appear elsewhere in the body.)

The system prompt MUST NOT include the sentence `"Open with a one-sentence framing of the section's theme. Close with a one-sentence transition or summary."` (from the v1 prompt). That instruction was the documented root cause of trailing-padding artifacts.

The structural inputs to `writeSection` (a `(label, facts[], originalTask)` triple) are unchanged in S1. The cluster-to-claim inversion is S2's concern.

#### Scenario: Generated section opens with thesis, not framing fluff

- **WHEN** `writeSection({label, facts}, ctx)` returns a body for a non-trivial cluster
- **THEN** the first sentence of the body asserts a specific claim relevant to `label`
- **AND** the first sentence is not a generic framing like "This section explores…" or "Outsourcing companies face many challenges in the AI age."

#### Scenario: Banned closer-words do not appear as paragraph openers

- **WHEN** `writeSection(...)` returns a body
- **THEN** no paragraph in the body has its first word equal to "Furthermore", "Consequently", or "Ultimately"

#### Scenario: Old framing instruction is absent from prompt

- **WHEN** the source of `sections.ts` is inspected
- **THEN** the string `"Open with a one-sentence framing"` is NOT present in `SECTION_SYSTEM_PROMPT`
- **AND** the string `"Close with a one-sentence transition"` is NOT present

#### Scenario: Hedging instruction is present in the prompt

- **WHEN** the source of `sections.ts` is inspected
- **THEN** `SECTION_SYSTEM_PROMPT` contains language requiring the writer to hedge when a claim has fewer than 3 supporting facts or only single-source support

### Requirement: writeSectionFromClaim defends a specific claim using ranked evidence

The `writeSectionFromClaim(input, ctx, feedback?)` function SHALL accept:

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

…and a context `{originalTask}` plus an optional `feedback` string (used by the brutal-editor pass for the revision attempt), and return `{label: headline, body, factIds: number[], usedLocalIds: number[]}` (matching the existing `Section` shape so the stitcher consumes both functions identically).

The system prompt SHALL instruct the model to:

1. **Open** with a single thesis sentence asserting the *claim*. Do NOT hedge or qualify in the opening unless triangulation says so.
2. **Body** must rank the supporting facts by importance — most load-bearing first. The `rankedFacts` array is already sorted; the prose ordering should follow it.
3. **Cite** every factual claim with `[N]` matching `localId`. The fact-numbering rules from the legacy writer (filter out-of-range citations, retry-once on empty body) carry forward.
4. **Triangulation directives**:
   - If `corroborations >= 2 AND !contested`: assert the claim with normal confidence.
   - If `corroborations < 2 OR rankedFacts.length < 3`: hedge ("Evidence is thin, but…", "One source argues…").
   - If `contested === true`: explicitly surface the contention ("Sources disagree: X argues …, while Y reports …") and cite both sides.
5. **Drop weak facts**: if a fact in `rankedFacts` doesn't actually support the claim on inspection, the model is instructed to OMIT it rather than paraphrase it.
6. **No closing transitional sentence**. No "Furthermore"/"Consequently"/"Ultimately" as paragraph openers. (Same as the legacy rule; carried into the new function.)

When `feedback` is supplied, it is appended to the user message inside an `<editor_feedback>` block — the brutal-editor pass uses this on revision attempts.

The function MUST use `llm.fast` (no thinking). It MUST follow the existing two-attempt + filter-citations + word-count pattern. It MUST emit one `section.written` event on completion (same shape as the existing function).

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

#### Scenario: Feedback is used during revision

- **GIVEN** a brutal-editor revision call passing `feedback = 'No concrete example named'`
- **WHEN** `writeSectionFromClaim(input, ctx, feedback)` runs
- **THEN** the user message sent to the LLM contains an `<editor_feedback>` block with the feedback string

### Requirement: Banned-closer-words deterministic post-processor

After a section body is returned by `writeSection` or `writeSectionFromClaim`, the system SHALL apply a deterministic post-processor `removeBannedClosers(body)` that rewrites the opening word of the **last paragraph** when that word is one of the banned closers.

Banned set: `Furthermore`, `Consequently`, `Ultimately`. Match is case-sensitive and applies only when the word is at the very start of the last paragraph followed by a comma OR space-and-lowercase-letter (i.e., the model is opening a transitional sentence).

When matched, the offending word is replaced by one of `As such,` / `In sum,` / `That is,` (rotating). The rest of the paragraph is unchanged.

The post-processor MUST run AFTER `filterCitations` (so it doesn't accidentally move citation markers around) and BEFORE the body is included in the returned `Section.body`. Both `writeSection` (cluster fallback path) and `writeSectionFromClaim` (thesis path) MUST apply it.

Mid-body uses of the banned words (i.e., not as the opener of the last paragraph) are NOT touched. The original prompt rule was scoped to closing paragraphs.

> **Known limitation:** the regex matches the first word of the last *paragraph*. When a section is a single paragraph that ends with a transitional sentence (e.g., `"…Ultimately, the concept of human-in-the-loop has emerged as a central principle"`), the regex does not fire because `Ultimately` is mid-paragraph from the regex's perspective. Tracked as a future tune; broaden to first-word-of-last-sentence-in-closing-zone if real-task reports show recurrent single-paragraph violations.

#### Scenario: Closing paragraph opening with "Ultimately" is rewritten

- **GIVEN** a section body whose last paragraph starts with `"Ultimately, the lack of a stable pricing mechanism..."`
- **WHEN** `removeBannedClosers(body)` runs
- **THEN** the returned body's last paragraph starts with one of `"As such,"`, `"In sum,"`, or `"That is,"`
- **AND** the rest of that paragraph is byte-identical to the input

#### Scenario: Banned word in the middle of a paragraph is preserved

- **GIVEN** a section body containing `"Consequently"` in the middle of a non-final paragraph
- **WHEN** `removeBannedClosers(body)` runs
- **THEN** the input paragraph is byte-identical to the output for that paragraph
- **AND** only a final-paragraph opener is candidate for rewrite

#### Scenario: No banned closer leaves body untouched

- **GIVEN** a section body whose last paragraph starts with `"This shift forces a pivot..."`
- **WHEN** `removeBannedClosers(body)` runs
- **THEN** the returned body is byte-identical to the input

#### Scenario: Both writeSection variants apply the post-processor

- **WHEN** the source of `sections.ts` is inspected
- **THEN** `writeSection(...)` calls `removeBannedClosers` on its filtered body before returning
- **AND** `writeSectionFromClaim(...)` calls `removeBannedClosers` on its filtered body before returning

