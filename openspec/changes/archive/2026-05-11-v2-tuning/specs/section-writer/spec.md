# section-writer Specification (delta)

## ADDED Requirements

### Requirement: Banned-closer-words deterministic post-processor

After a section body is returned by `writeSection` or `writeSectionFromClaim`, the system SHALL apply a deterministic post-processor `removeBannedClosers(body)` that rewrites the opening word of the **last paragraph** when that word is one of the banned closers.

Banned set: `Furthermore`, `Consequently`, `Ultimately`. Match is case-sensitive and applies only when the word is at the very start of the last paragraph followed by a comma OR space-and-lowercase-letter (i.e., the model is opening a transitional sentence).

When matched, the offending word is replaced by one of `As such,` / `In sum,` / `That is,` (rotating). The rest of the paragraph is unchanged.

The post-processor MUST run AFTER `filterCitations` (so it doesn't accidentally move citation markers around) and BEFORE the body is included in the returned `Section.body`. Both `writeSection` (cluster fallback path) and `writeSectionFromClaim` (thesis path) MUST apply it.

Mid-body uses of the banned words (i.e., not as the opener of the last paragraph) are NOT touched. The original prompt rule was scoped to closing paragraphs.

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
