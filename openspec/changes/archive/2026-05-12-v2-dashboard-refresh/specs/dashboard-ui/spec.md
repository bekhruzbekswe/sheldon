# dashboard-ui Specification (delta)

## ADDED Requirements

### Requirement: Event family map covers all v2 event kinds

The browser front-end's `KIND_FAM` object (in `web/index.html`) SHALL include explicit mappings for every event kind in the closed `EventKind` union (from `src/events.ts`), including the v2 additions: `source.classified`, `fact.dropped.irrelevant`, `contract.drafted`, `contract.revised`, `gap.analyzed`, `thesis.drafted`, `claim.triangulated`, `section.rubric`, `section.dropped`, `synthesis.fallback`.

Mappings:

- `source.classified` → family `"source"` (new family)
- `fact.dropped.irrelevant` → family `"fact"` (existing family)
- `contract.drafted` → family `"contract"` (new family)
- `contract.revised` → family `"contract"`
- `gap.analyzed` → family `"gap"` (new family)
- `thesis.drafted` → family `"synthesis"` (existing family)
- `claim.triangulated` → family `"synthesis"`
- `section.rubric` → family `"synthesis"`
- `section.dropped` → family `"synthesis"`
- `synthesis.fallback` → family `"synthesis"`

The three new families (`"source"`, `"contract"`, `"gap"`) MUST have corresponding CSS color variables (`--k-source`, `--k-contract`, `--k-gap`) and filter chips in the dashboard's family-filter UI, mirroring the existing family treatment.

No v2 event kind SHALL fall through to a generic / default family. Each kind in the closed union has an explicit row in `KIND_FAM`.

#### Scenario: New v2 event renders with proper family color

- **GIVEN** the dashboard is open and connected to the SSE stream
- **WHEN** a `gap.analyzed` event is appended to `events.jsonl`
- **THEN** the rendered log line uses the `--k-gap` color
- **AND** the line is filterable via the `"gap"` family chip
- **AND** the line is NOT classified under the `"iteration"` family

#### Scenario: KIND_FAM has explicit entries for every closed-union kind

- **WHEN** the source of `web/index.html` is inspected and the `KIND_FAM` map is enumerated
- **THEN** for every kind in `src/events.ts`'s `EventKind` union, there exists a key in `KIND_FAM` with that exact string

### Requirement: Synthesis overlay reflects the v2 substep tree

The dashboard MUST render the synthesis-phase overlay as a vertical list of substeps, NOT as the legacy placeholder text *"clusters forming…"*. The substep tree (in display order):

1. **Thesis** — completed when at least one `thesis.drafted` event has fired; summary: `<N> claims drafted`.
2. **Triangulate** — active when at least one `claim.triangulated` event has fired and `report.written` has not; summary: `<triangulated>/<thesisClaimCount> triangulated`.
3. **Write sections** — active when at least one `section.written` event has fired after the most-recent `thesis.drafted`; summary: `<written>/<thesisClaimCount> written, <dropped> dropped`.
4. **Brutal edit** — active when at least one `section.rubric` event fires for a section that already has a `section.written`; summary line shows nothing or the per-section rubric pass/fail count.
5. **Stitch report** — active when written count ≥ thesis claim count and `report.written` has not yet fired.
6. **Done** — set when `report.written` fires; summary shows the report path.

Each substep MUST have one of three visual states:

- `.is-done` — substep is in the past (an event past it has fired).
- `.is-active` — substep is currently running.
- (neither) — substep is in the future, displayed in a dimmed state.

When `synthesis.fallback` is present in the synthesis sub-trace, the overlay SHALL replace the substep tree with a single fallback row: `Cluster fallback — reason: <fallbackReason>` (plus the running section counts). The fallback row is mutually exclusive with the substep tree.

On page load OR when transitioning into the synthesis phase, the UI MUST call `GET /api/synthesis-state` once to get an initial snapshot. After the snapshot, the UI MUST update from the SSE event stream as relevant kinds arrive (`thesis.drafted`, `claim.triangulated`, `section.written`, `section.rubric`, `section.dropped`, `synthesis.fallback`, `report.written`).

#### Scenario: Overlay shows triangulation in progress

- **GIVEN** a run currently in synthesis phase with thesis drafted (6 claims) and 3 claims triangulated
- **WHEN** the dashboard renders the overlay (after page load + initial snapshot)
- **THEN** the `Thesis` substep has class `.is-done` with summary `"6 claims drafted"`
- **AND** the `Triangulate` substep has class `.is-active` with summary `"3/6 triangulated"`
- **AND** the `Write sections` / `Brutal edit` / `Stitch report` substeps are displayed in a dimmed state with no `.is-active` or `.is-done` class

#### Scenario: Cluster fallback overlay supplants the substep tree

- **GIVEN** the latest `synthesis.fallback` event with `payload.reason: "sparse_corpus"` has fired
- **WHEN** the dashboard renders the overlay
- **THEN** the substep tree is hidden
- **AND** a single row reads `"Cluster fallback — reason: sparse_corpus"`

#### Scenario: Finished run shows done + report path

- **GIVEN** a `report.written` event has fired with `payload.path: ".sheldon/reports/X.md"`
- **WHEN** the dashboard renders the overlay
- **THEN** all substeps up to and including `Stitch report` are `.is-done`
- **AND** a "Done" affordance shows the report path

### Requirement: Synth headline and subtitle reflect the current substep

The `<h2 class="synth-h">` headline and `<p class="synth-sub">` subtitle inside the synth panel SHALL be dynamic, updating from the current `synthState.substep`:

| substep | headline | subtitle |
|---|---|---|
| `idle` | "Synthesis pending" | "Waiting for breadth + depth gathering to complete." |
| `thesis-drafting` | "Drafting the thesis" | "Sampling the most task-relevant, source-diverse evidence to draft 4–7 load-bearing claims." |
| `triangulating` | "Triangulating load-bearing claims" | "Running targeted corroborate / contradict searches per claim." |
| `writing` | "Writing one section per claim" | "Each section defends its claim with ranked evidence." |
| `editing` | "Brutal-editing weak sections" | "Each section is checked against a rubric; failures get one revision attempt, then drop." |
| `stitching` | "Stitching the final report" | "Renumbering citations, rendering intro and conclusion." |
| `done` | "Report ready" | "Click any citation in the rendered report to open its source in a new tab." |
| `fallback` | "Falling back to cluster synthesis" | "The thesis path returned no usable claims; the legacy cluster pipeline is producing the report." |

The headline and subtitle update on every state transition (i.e., re-rendered as part of `renderSynth()`).

#### Scenario: Headline reflects active substep

- **GIVEN** a run where the latest event is `claim.triangulated`
- **WHEN** `renderSynth()` runs after applying that event
- **THEN** `#synth-headline` text is `"Triangulating load-bearing claims"`
- **AND** the subtitle reflects the matching substep description

#### Scenario: Headline reflects done state

- **GIVEN** a run where `report.written` has fired
- **WHEN** `renderSynth()` runs
- **THEN** `#synth-headline` text is `"Report ready"`
- **AND** the subtitle invites the user to click citation links

### Requirement: Facts panel "by topic" filter is functional

The Facts panel SHALL provide two view modes selected via the chips next to the panel title: `recent` (default) and `by topic`. Clicking a chip MUST toggle the `is-on` class such that only one chip is active at a time, AND re-render the facts list according to the selected mode:

- **recent**: facts sorted by `ts` descending (newest first). Each fact rendered as the existing fact-row layout (id + claim + meta + foot).
- **by topic**: facts grouped by `f.topic` (falling back to `"misc"` when topic is missing/empty). Each group shows a heading row containing a topic chip (using the same `.topic` styling as in the fact-foot) and the count of facts in the group, followed by the fact rows for that group. Groups are sorted by size descending; within a group, facts are sorted by `ts` descending.

The view-mode toggle persists in-memory for the lifetime of the dashboard tab (no cookies / localStorage required).

#### Scenario: Clicking "by topic" re-renders grouped facts

- **GIVEN** the facts panel currently shows facts in "recent" mode
- **WHEN** the user clicks the "by topic" chip
- **THEN** the "by topic" chip has class `is-on` and the "recent" chip does not
- **AND** the facts list is re-rendered: each distinct topic in the fact set has a heading row at its position, followed by the facts belonging to that topic

#### Scenario: Clicking "recent" returns to recency-sorted view

- **GIVEN** the facts panel is in "by topic" mode
- **WHEN** the user clicks the "recent" chip
- **THEN** the "recent" chip is active and the facts list is sorted by `ts` descending without group headers

### Requirement: Facts count badge updates from iteration.end events

The `#facts-count` span next to the Facts panel title SHALL display `+<N> in last iter` where `<N>` is the `payload.factsAdded` value from the most-recent `iteration.end` SSE event observed by the dashboard tab. Before any `iteration.end` has been observed (e.g., on initial page load mid-iteration), the span SHALL display `"—"` or be empty rather than a stale hardcoded number.

The static hardcoded string `+22 in last iter` MUST be removed from `web/index.html`.

#### Scenario: Count updates on iteration.end

- **GIVEN** the dashboard tab is open and an `iteration.end` SSE event arrives with `payload.factsAdded: 17`
- **WHEN** the dashboard processes the event
- **THEN** `#facts-count` text is `"+17 in last iter"`

#### Scenario: No hardcoded count in served HTML

- **WHEN** the dashboard HTML is served
- **THEN** the string `"+22 in last iter"` does NOT appear anywhere in the served HTML

### Requirement: In-browser report viewer with clickable citations

When the run reaches a state where a report exists (`reportPath !== null` from `/api/synthesis-state` OR `phase === 'done'` from `/api/run-state`), the dashboard SHALL fetch `/api/report` and render the returned HTML in its own **full-width section below the synth panel** (NOT inside the synth panel's right column). The report-viewer section is hidden when no report exists.

The rendered report:

- Displays the full markdown rendered to HTML (headings, paragraphs, lists, inline formatting).
- Citation tokens `[N]` are clickable links opening the source URL in a new tab (`target="_blank" rel="noopener"`).
- The `## Sources` section at the bottom renders as a numbered list with each source title and URL as a link.
- The wrapping section uses the same panel-card styling as the rest of the dashboard (border, rounded corners, padding); the inner viewer is scrollable when the report is longer than its natural max-height.

Before any report exists, the report section is hidden (`display: none`). On fetch failure, the section stays hidden — no visible loading shimmer or fallback placeholder.

#### Scenario: Citation [N] is a clickable link in the rendered report

- **GIVEN** `phase === 'done'` and `/api/report` returns a body containing `<a href="https://example.com" target="_blank" rel="noopener" class="citation">[3]</a>`
- **WHEN** the dashboard renders the report HTML
- **THEN** clicking the `[3]` link opens `https://example.com` in a new tab
- **AND** the link has `rel="noopener"` so the new tab cannot reach back into the dashboard

#### Scenario: Report section is its own full-width box below synth

- **GIVEN** the run has reached `phase === 'done'` with a non-null reportPath
- **WHEN** the dashboard renders the page
- **THEN** the rendered report is in a full-width `<section class="report-section">` placed AFTER the synth panel in document order
- **AND** the report content is NOT a child of the synth panel's right column
- **AND** the synth panel itself uses a single-column layout (no right column containing sections list / ready banner)

### Requirement: Synth substep tree uses the dashboard's staircase pipeline visual language

The substep rows in the synth panel SHALL use the same visual treatment as the pipeline cards in the header row (the `.pipe-card` style: mono uppercase label, left number prefix, right-aligned value, border on the leading edge, staircase widths increasing top-to-bottom), but anchored to the LEFT of their container instead of the right.

Specifically:

- Each substep row has three columns: a number (1–6), a name in monospace uppercase letters with wide letter-spacing, and a summary value/status indicator on the right.
- Border on the LEFT edge of each row (matching the pipe-card's right-side border, mirrored).
- Container `justify-items: start` (left-aligned, opposite of pipe-cards' `justify-items: end`).
- Widths increase as a staircase: row 1 narrowest, row 6 widest. Exact widths per the implementation (e.g., 55%, 64%, 73%, 82%, 91%, 100%).
- Active row: brighter foreground color, optional border-color highlight in the synthesis hue. Done rows: dimmed.
- The substep tree as a whole is more compact than the previous "card with rounded edges" treatment — the synth panel becomes shorter and reads consistently with the pipeline cards at the top of the page.

The substep ordering remains `1 Thesis → 2 Triangulate → 3 Write → 4 Edit → 5 Stitch → 6 Done`.

#### Scenario: Substep rows use staircase layout

- **WHEN** the served HTML and CSS are inspected
- **THEN** the substep rows have `width` declarations that increase monotonically from row 1 to row 6
- **AND** each row has its primary border on the LEFT edge (not the right)
- **AND** each row uses a monospace font with uppercase letter-spacing for the label

#### Scenario: Synth panel is single-column

- **WHEN** the synth panel is inspected
- **THEN** it does NOT contain a right column with `#sections` or `#report-ready` or `#report-viewer`
- **AND** the synth panel's CSS uses a single-column layout (no `grid-template-columns: 1.2fr 1fr`)

### Requirement: Cluster-vocabulary DOM and CSS renamed off v1 vocabulary

The dashboard's DOM and CSS in `web/index.html` SHALL NOT use cluster-specific identifier names where the actual semantic is "synthesis substep progress". Specifically:

- The `<div id="clusters">` element SHALL be renamed to `<div id="synth-progress">`.
- The CSS classes `.clusters` and `.cluster` SHALL be renamed / split into `.synth-substeps` (the container) and `.synth-substep` (each substep row), with modifier classes `.is-active` and `.is-done` as described above.
- All inline JS selectors targeting the old IDs / classes SHALL be updated to the new names. No legacy aliases.

This rename is internal-only. No external scripts or bookmarklets target these names (single-user observability surface). The container's overall layout and CSS positioning is preserved — only the names change.

#### Scenario: Cluster-named DOM is gone

- **WHEN** the source of `web/index.html` is inspected after this change
- **THEN** there is no element with `id="clusters"`
- **AND** there are no CSS class names `clusters` or `cluster` (singular or plural)
- **AND** the new names `synth-progress`, `synth-substeps`, `synth-substep` are present
