# event-log Specification

## Purpose

Append-only structured telemetry sink. Every action in every layer of Sheldon emits one event here, written as a single JSON line to `.sheldon/events.jsonl`. Provides the visibility primitive that lets the user verify in real time what the agent is doing during a multi-hour run.
## Requirements
### Requirement: Append events as JSON lines to a file

The event log SHALL append each event as a single JSON object followed by a newline to `.sheldon/events.jsonl` relative to the process's current working directory. The directory and file MUST be created on first write if they do not exist. Writes MUST NOT mutate prior lines (append-only).

#### Scenario: First event creates file and directory

- **GIVEN** `.sheldon/` does not exist
- **WHEN** `events.emit({kind:'llm.fast', layer:'L0', payload:{}})` is called
- **THEN** `.sheldon/events.jsonl` exists
- **AND** the file contains exactly one line that is valid JSON with fields `ts`, `kind`, `layer`, `payload`

#### Scenario: Subsequent events append without overwriting

- **GIVEN** `.sheldon/events.jsonl` already contains 3 lines
- **WHEN** `events.emit(...)` is called twice more
- **THEN** the file contains 5 lines total in chronological order
- **AND** each prior line is byte-identical to its earlier state

### Requirement: Event has typed kind, layer, and payload

Each event SHALL have a `ts` (ISO-8601 with millisecond precision), a `kind` (string from a typed union), a `layer` (string identifying the originating layer like `"L0"`, `"L2"`), an optional `durationMs` (positive number), and a `payload` (any JSON-serializable value).

#### Scenario: Event shape is fully populated

- **WHEN** an event is emitted via `events.emit({kind:'llm.fast', layer:'L0', durationMs:810, payload:{tokens:4}})`
- **THEN** the resulting JSON line contains `ts`, `kind`, `layer`, `durationMs`, and `payload` fields
- **AND** `ts` matches the regex `\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z`

### Requirement: Kind taxonomy is enforced at compile time

The TypeScript type for `kind` SHALL be a closed union covering all event kinds emitted by every layer that has shipped, including: `'llm.fast' | 'llm.deep' | 'search.query' | 'scrape.fetch' | 'scrape.skip' | 'summary.write' | 'chunk.split' | 'embed.batch' | 'claim.extract' | 'fact.write' | 'fact.dedupe' | 'frontier.seed' | 'frontier.push' | 'frontier.dedupe' | 'frontier.pop' | 'frontier.done' | 'frontier.skip' | 'iteration.start' | 'iteration.end' | 'phase.transition' | 'run.start' | 'run.end' | 'cluster.computed' | 'section.written' | 'report.written' | 'resume.detected' | 'resume.applied'`. Emitting an unrecognized kind MUST fail type checking. The taxonomy MUST be extended through this module's source, not by callers.

#### Scenario: Unknown kind fails to type-check

- **WHEN** caller writes `events.emit({kind:'definitely-not-real', layer:'L0', payload:{}})`
- **THEN** `bun run typecheck` reports an error on that line

#### Scenario: New L7 kinds are accepted

- **WHEN** caller writes `events.emit({kind:'resume.applied', layer:'L7', payload:{}})` or `'resume.detected'`
- **THEN** `bun run typecheck` passes

### Requirement: Emit operation is non-throwing on I/O failure

If the event-log writer cannot append to the file (disk full, permissions, etc.), the emit operation SHALL log the failure to `console.error` and return without throwing. The agent's main loop MUST NOT die because telemetry failed.

#### Scenario: Disk failure is swallowed

- **GIVEN** writes to `.sheldon/events.jsonl` will fail
- **WHEN** `events.emit(...)` is called
- **THEN** no exception propagates to the caller
- **AND** an error message is printed to stderr describing the failure

