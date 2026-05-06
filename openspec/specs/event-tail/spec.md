# event-tail Specification

## Purpose

Terminal CLI that follows the event log in real time, formatting each event as one colored line with optional `--kind`, `--layer`, and `--since` filters. The user-facing companion to `event-log`.

## Requirements
### Requirement: Tail the JSONL log and render one line per event

The `bun run watch` command SHALL open `.sheldon/events.jsonl` and stream existing lines plus new appends to stdout, formatting each event as a single human-readable line with ANSI color coding by kind family.

#### Scenario: Following an existing log

- **GIVEN** `.sheldon/events.jsonl` has 3 lines
- **WHEN** `bun run watch` is started
- **THEN** stdout shows 3 lines of formatted output (one per existing event)
- **AND** the process remains alive, awaiting new appends

#### Scenario: New events appear live

- **GIVEN** `bun run watch` is running and has caught up
- **WHEN** another process appends a line to `.sheldon/events.jsonl`
- **THEN** the new event appears as a formatted line on `watch`'s stdout within 1 second

### Requirement: Filter events by kind, layer, or time

The watch command SHALL accept the flags `--kind <pattern>` (comma-separated, supports trailing wildcard like `llm.*`), `--layer <id>` (comma-separated, exact match), and `--since <duration>` (e.g. `5m`, `1h`). Events not matching all provided filters MUST be omitted from output.

#### Scenario: Kind filter narrows output

- **GIVEN** the log has events of kinds `llm.fast`, `llm.deep`, `search.query`
- **WHEN** `bun run watch --kind llm.*` is run
- **THEN** stdout shows only events of kinds starting with `llm.`

#### Scenario: Time filter excludes old events

- **GIVEN** the log has 10 events, the oldest 6 of which were written more than 10 minutes ago
- **WHEN** `bun run watch --since 5m` is run
- **THEN** stdout shows only the 4 events from within the last 5 minutes

### Requirement: Output format includes timestamp, kind, layer, and concise payload

Each rendered line SHALL include the wall-clock time (HH:MM:SS), the kind in uppercase, the layer in brackets, the duration in parentheses if present, and a single-line payload summary. Long payload fields MUST be truncated to keep each line readable in a typical terminal (target ≤120 chars).

#### Scenario: Long payload is truncated

- **WHEN** an event with a 5000-character payload string is emitted
- **THEN** the rendered line is no longer than 200 characters total
- **AND** the truncated content is suffixed with `…`

