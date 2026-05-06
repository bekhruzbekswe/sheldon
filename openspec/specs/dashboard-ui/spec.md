# dashboard-ui Specification

## Purpose

Single-page browser dashboard at `web/index.html` rendering the Claude-Design `Sheldon Dashboard v2.html` against real data. Vanilla JS, no framework, no bundler, no third-party runtime deps. Polls REST snapshots (run state and frontier every 2s; facts and stats every 5s) and consumes the SSE event stream for the live firehose. Visual output matches the design verbatim — only the data layer was changed; layout, animations, color tokens, and DOM are preserved. Empty state, active run, and synthesis takeover all driven from `phase` in the polled run state.

## Requirements
### Requirement: Single self-contained HTML page

The dashboard UI SHALL be a single `web/index.html` file with inline `<style>` and inline `<script>` tags. It MUST NOT load JavaScript or CSS from any external host except Google Fonts (used by the original design for Inter + JetBrains Mono). It MUST NOT bundle any framework (React, Vue, etc.).

#### Scenario: Page loads without bundler

- **WHEN** `bun run dashboard` is started and a browser navigates to `/`
- **THEN** the page renders fully without any 404s in the console (other than Google Fonts which is acceptable)

### Requirement: Visual output matches the design artifact

The HTML SHALL preserve every CSS rule, layout grid, color token, animation keyframe, and DOM structure from the source design (`Sheldon Dashboard v2.html`) so the rendered visual output is byte-for-byte identical given equivalent data. Only the data-source code (mock generators, hardcoded arrays, sample event spawning) MAY be changed.

#### Scenario: Rendered design unchanged

- **WHEN** the dashboard renders against equivalent mock-vs-real data
- **THEN** there are no visual differences in layout, typography, or color from the source design

### Requirement: Polls REST endpoints for snapshot data

The page SHALL `fetch('/api/run-state')` and `fetch('/api/frontier')` every 2 seconds, and `fetch('/api/facts')` and `fetch('/api/stats')` every 5 seconds. It MUST start a fresh request only after the prior one resolved (no overlapping fetches).

#### Scenario: Polling cadence

- **WHEN** the page is open for 30 seconds
- **THEN** there have been ~15 requests to `/api/run-state` and ~6 requests to `/api/facts`

### Requirement: Subscribes to SSE for live events

The page SHALL open a single `EventSource('/api/events')` on load. Each incoming message's `data` SHALL be `JSON.parse`'d and passed to the existing log-rendering pipeline (`pushEvent`). The page MUST NOT generate synthetic events.

#### Scenario: New event line lights up the log

- **GIVEN** the page is open
- **WHEN** the server emits an SSE event with `kind: 'fact.write'` and a summary
- **THEN** within 1 second a new `.log-line[data-fam="fact"]` appears at the top of the `#log` element

### Requirement: Empty-state when no run is active

When `/api/run-state` returns `{phase: 'idle'}`, the page SHALL set `document.body.dataset.phase = 'idle'`, which the design's CSS uses to hide the run/stats/lower/log sections and show the empty-state element.

#### Scenario: Idle empty state

- **GIVEN** `/api/run-state` returns `phase: 'idle'`
- **WHEN** the page receives that response
- **THEN** `document.body.dataset.phase === 'idle'`
- **AND** the `.empty` element is visible

### Requirement: SSE reconnect on disconnect

If the EventSource closes (server restart, network blip), the page SHALL transparently reconnect via the browser's built-in EventSource retry. It MUST NOT show an error UI for a brief disconnect; if the disconnect persists for more than 30 seconds, a small inline indicator in the log header MAY appear (optional polish).

#### Scenario: Server restart is invisible during smoke test

- **GIVEN** the page is open and the server is restarted
- **WHEN** the server comes back up within ~5 seconds
- **THEN** the page resumes receiving SSE events without manual reload

