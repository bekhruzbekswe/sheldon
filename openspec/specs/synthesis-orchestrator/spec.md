# synthesis-orchestrator Specification

## Purpose

The dispatch layer that owns the synthesis phase's order of operations. Decides between the thesis path (default) and the cluster fallback path (sparse corpus or thesis failure), runs triangulation, performs per-claim fact retrieval with source-weighted ranking, drives the brutal-editor revise-or-drop pass, and calls the stitcher last. Lives in `src/synthesize.ts`.

## Requirements

### Requirement: Synthesis tries the thesis path first, falls back to cluster path

When the synthesis phase is reached and the corpus has at least one fact, the orchestrator SHALL:

1. Read the run state (`getRunState()`) and load the contract.
2. Call `draftThesis(task, contract, allFactsWithEmbeddings)`.
3. **If thesis-drafting succeeds** (returns a non-null result with ≥3 claims AND `factStore.count() >= 30`): proceed with the thesis path (next requirement).
4. **Otherwise**: emit `synthesis.fallback` with `payload: {reason: 'thesis_failed' | 'thesis_returned_null' | 'sparse_corpus', factCount, validClaims?}` and proceed with the cluster path (call `clusterFacts(...)` and write per cluster).

The cluster fallback path MUST use the existing `writeSection(input, ctx)` function so prompt-level wins from S1 are preserved when fallback fires.

`MIN_FACTS_FOR_THESIS` is a per-file constant in `src/synthesize.ts` with value `30`.

#### Scenario: Sparse corpus skips thesis-drafting

- **GIVEN** a synthesis run where `factStore.count() === 18`
- **WHEN** the orchestrator runs
- **THEN** `draftThesis` is NOT called
- **AND** one `synthesis.fallback` event has been emitted with `reason: 'sparse_corpus'`
- **AND** `clusterFacts` is called

#### Scenario: Thesis returns null triggers fallback

- **GIVEN** a corpus of 80 facts and a thesis-drafter that returns null
- **WHEN** the orchestrator runs
- **THEN** one `synthesis.fallback` event has been emitted with `reason: 'thesis_returned_null'`
- **AND** `clusterFacts` is called and produces the report

### Requirement: Thesis path order of operations

When the thesis path is taken, the orchestrator SHALL execute steps in this order:

1. **Triangulate** each thesis claim via the `claim-triangulator` capability (budget-bounded). New facts may flow into the corpus.
2. **Per-claim fact retrieval**: for each claim, score every fact by `cosine(fact, claim_embedding) + 0.15 * source_weight(fact) − 0.05 * domain_repeat_count(fact, picked_so_far)`, take top-K (per-file constant `FACTS_PER_CLAIM = 10`).
3. **Write each section**: call `writeSectionFromClaim(claim, headline, rankedFacts, triMeta, ctx)`.
4. **Brutal-editor pass** (next requirement).
5. **Stitch**: call `stitchReport` with the surviving sections, the thesis text, and per-claim metadata for intro/outro. The stitcher receives `path: 'thesis'` so headlines render verbatim (not slug-transformed).

If a claim's top-K retrieved facts have `cosine(fact, claim) < 0.30` for ≥80% of them, the claim is *thin-evidence*: written with explicit thin-evidence framing (the writer's existing rules already handle this since `corroborations < 2` triggers hedging). Per-file constant `MIN_CLAIM_SUPPORT_THRESHOLD = 0.30`, `MIN_CLAIM_SUPPORT_FRACTION = 0.80`.

The orchestrator MUST emit a `synthesis.fallback` event ONLY if the cluster path is taken — the thesis path itself emits per-claim and per-section events from the dedicated capabilities.

#### Scenario: Per-claim retrieval respects source weights

- **GIVEN** two facts have equal `cosine(fact, claim)`, one from an `academic` source and one from a `vendor` source
- **WHEN** the orchestrator scores them for the same claim
- **THEN** the academic-source fact has a higher final score
- **AND** ranks ahead of the vendor-source fact

#### Scenario: Domain repeat penalty bumps low-cosine alternatives up

- **GIVEN** the picked-so-far list for one claim already contains 4 facts from `a16z.com`
- **WHEN** the next candidate from `a16z.com` (cosine=0.7) competes with a candidate from `tcs.com` (cosine=0.65)
- **THEN** the a16z fact's effective score is `0.7 - 0.05*4 = 0.50`
- **AND** the tcs fact (effective `0.65 - 0`) ranks higher

### Requirement: Brutal-editor pass with revise-then-drop

After all sections are written, the orchestrator SHALL run `evaluateSection(body, claim)` on each. A section *fails* the rubric when:

```
fails = (has_mechanism === false AND has_example === false) OR defends_heading === false
```

For each failing section: append the rubric `note` to the writer's user message as feedback, call `writeSectionFromClaim` once more (revision attempt), then re-run the rubric. If the section *still fails* and `BRUTAL_EDIT_MODE === 'drop'` (per-file default), the section is dropped from the report and one `section.dropped` event is emitted with `payload: {headline, reason: rubricNote}`.

When `BRUTAL_EDIT_MODE === 'flag'` (runtime fallback for over-aggressive editing), a still-failing section SHALL be retained in the report with a hedge prepended ("Evidence in this section is uneven: ...") rather than dropped.

The total brutal-editor budget is at most one revision attempt per section. No multi-revision loops.

#### Scenario: Section passes rubric on first try

- **GIVEN** a written section that passes all rubric checks
- **WHEN** the brutal-editor pass runs
- **THEN** no revision is attempted
- **AND** the section is included in the final report
- **AND** no `section.dropped` event is emitted for it

#### Scenario: Section fails twice and is dropped (default mode)

- **GIVEN** a written section where `defends_heading === false` after both initial writing and one revision
- **WHEN** the brutal-editor pass runs with `BRUTAL_EDIT_MODE === 'drop'`
- **THEN** the section does NOT appear in the stitched report
- **AND** one `section.dropped` event is emitted with the rubric note

#### Scenario: Flag mode retains failing sections with a hedge

- **GIVEN** a section that fails twice and `BRUTAL_EDIT_MODE === 'flag'`
- **WHEN** the brutal-editor pass runs
- **THEN** the section appears in the report with a prepended hedge sentence
- **AND** no `section.dropped` event is emitted for it
