# section-writer Specification (delta)

## ADDED Requirements

### Requirement: System prompt requires ranked thesis-led prose without transitional padding

The `SECTION_SYSTEM_PROMPT` used by `writeSection` SHALL instruct the model to:

1. **Open** with a single thesis sentence stating the section's claim. (Replaces the prior "framing" instruction.)
2. **Body** must rank the supporting points by importance — most-load-bearing first.
3. **Acknowledge contradictions** explicitly when sources disagree, citing both sides.
4. **Hedge thin evidence**: when a claim is supported by fewer than 3 distinct facts or only one source, the prose MUST hedge ("Evidence is thin, but…" / "One source argues…") rather than asserting confidently.
5. **Omit weakly-supported claims** entirely rather than paraphrasing weak evidence.
6. **No closing transitional sentence**. The section ends on the body's final point, not on a meta-summary.
7. The words `"Furthermore"`, `"Consequently"`, and `"Ultimately"` MUST NOT appear as the *first word* of any closing paragraph. (They MAY appear elsewhere in the body.)

The system prompt MUST NOT include the sentence `"Open with a one-sentence framing of the section's theme. Close with a one-sentence transition or summary."` (from the v1 prompt). That instruction is the documented root cause of trailing-padding artifacts in reports A and B.

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
