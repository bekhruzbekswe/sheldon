# thesis-drafter Specification

## Purpose

At the start of the synthesis phase, the thesis-drafter takes the gathered fact corpus and produces (a) the report's actual claim — 3 to 5 thesis sentences that, read together, are a real answer to the user's research task — and (b) 4 to 7 numbered claims that structure the thesis, each with its own headline (becomes a section H2) and embedding (drives per-claim fact retrieval). It replaces the role that k-means clustering played in v1 / S1: the report's structure now comes from a drafted argument, not from k-means topology. When the corpus is sparse or thesis-drafting fails, the synthesis-orchestrator falls back to the cluster path.

## Requirements

### Requirement: Draft a thesis and 4-7 numbered claims at synthesis start

The system SHALL produce a thesis artifact at the start of the synthesis phase, *before* any section is written. The artifact has shape:

```json
{
  "thesis_sentences": ["string", "..."],   // 3 to 5 sentences
  "claims": [
    {
      "claim": "string (one-sentence assertion)",
      "headline": "string (3-8 words, plain English Title Case, becomes the section H2)",
      "rationale": "string (one-line justification: why this claim earns a section)"
    }
    // 4 to 7 entries
  ]
}
```

The drafter is implemented as `draftThesis(task, contract, allFactsWithEmbeddings)` in `src/thesize.ts`. It MUST follow the project-wide structured-output pattern: `llm.fast` with `response_format: json_schema`, retry-once on parse failure, markdown-fence stripping as fallback. It MUST NOT use `llm.deep`.

If the LLM returns `claims.length < 3`, the drafter SHALL return `null` to signal the orchestrator to fall back to the cluster path. (3 is too few claims to structure a useful report.) If the LLM call fails after retry, return `null` similarly.

The drafter MUST emit one `thesis.drafted` event with `layer:'L6'`, `durationMs`, and a payload containing `claimCount`, `thesisSentenceCount`, `factSliceSize` (the number of facts fed into the prompt), `facts_per_domain_cap` (the per-domain cap actually applied), and an `error` field on failure.

#### Scenario: Successful thesis drafting

- **GIVEN** a fact store containing 80 facts across 12 distinct domains
- **WHEN** `draftThesis(task, contract, allFacts)` is called and the LLM returns a valid response
- **THEN** the function returns an object with `thesis_sentences.length` in `[3, 5]`
- **AND** `claims.length` in `[4, 7]`
- **AND** every claim has non-empty `claim`, `headline`, and `rationale` fields
- **AND** one `thesis.drafted` event has been emitted with positive `claimCount`

#### Scenario: Insufficient claims triggers fallback signal

- **GIVEN** an LLM response containing only 2 valid claims
- **WHEN** `draftThesis(...)` parses it
- **THEN** the function returns `null`
- **AND** one `thesis.drafted` event has been emitted with `error` payload describing the shortage

#### Scenario: LLM failure returns null without throwing

- **GIVEN** the LLM endpoint returns malformed JSON twice in a row
- **WHEN** `draftThesis(...)` is called
- **THEN** the function returns `null` (does not throw)
- **AND** one `thesis.drafted` event has been emitted with non-empty `error` field

### Requirement: Sample a task-relevance-sorted, source-diverse fact slice for the prompt

Before invoking the LLM, the drafter SHALL select a slice of facts from the corpus to fit in the prompt. Selection rules:

1. Sort all facts by `cosine(fact_embedding, task_embedding)` DESCENDING. Task embedding comes from `getTaskEmbedding()` (research-contract capability).
2. Walk the sorted list greedily. For each fact, accept it unless its source domain (via `extractDomain(sourceUrl)`) already appears `MAX_FACTS_PER_DOMAIN_THESIS` times in the picked set.
3. Stop when the picked set reaches `SLICE_SIZE` facts OR the source list is exhausted.

Per-file constants in `src/thesize.ts`: `SLICE_SIZE = 60`, `MAX_FACTS_PER_DOMAIN_THESIS = 3`. Both are starting values intended to be tuned from telemetry.

#### Scenario: Per-domain cap prevents source monopoly in the slice

- **GIVEN** a fact store where the top-100 facts by task-cosine include 18 facts from `a16z.com`
- **WHEN** the drafter selects its slice with `MAX_FACTS_PER_DOMAIN_THESIS = 3`
- **THEN** the picked slice contains at most 3 facts from `a16z.com`
- **AND** the remaining slice slots are filled by the next-most-relevant facts from other domains

#### Scenario: Slice respects SLICE_SIZE

- **GIVEN** a corpus of 200 facts
- **WHEN** the drafter samples
- **THEN** the prompt input contains at most `SLICE_SIZE = 60` facts

### Requirement: Embed each claim for downstream per-claim retrieval

After parsing the LLM response, the drafter SHALL embed every `claim.claim` string via `embedder.embed([claim1, claim2, ...])` (one batched call). Each claim object's resulting `Float32Array(384)` embedding MUST be attached to the in-memory representation passed to the synthesis orchestrator. Claim embeddings are NOT persisted to SQLite — they live only for the duration of the synthesis phase.

#### Scenario: All claims have embeddings after drafting

- **WHEN** `draftThesis(...)` returns a non-null result with N claims
- **THEN** the embedder is called exactly once with N claim strings
- **AND** every returned claim has a `embedding` field that is a Float32Array of length 384

### Requirement: Include the contract's good_answer_contains in the drafter prompt

The drafter prompt SHALL include the run's contract's `good_answer_contains` array as guidance for what a satisfying answer should cover. The drafter MUST NOT be required to enforce that every `good_answer_contains` item shows up as a claim — they're hints, not constraints. The drafter MAY refuse to invent a claim when no supporting evidence exists for a `good_answer_contains` item.

#### Scenario: Contract guidance reaches the prompt

- **GIVEN** a contract with `good_answer_contains` listing "FTE-based to outcome-based pricing shift" and "GCC competition"
- **WHEN** `draftThesis(...)` constructs its user message
- **THEN** the user message contains both phrases verbatim within a `<good_answer_contains>` block
