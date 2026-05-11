# Proposal — v2-dashboard-refresh

## Why

The audit done after v2 archival showed the L8 dashboard server is mostly up-to-date (the `format.ts` event formatter was updated as each stage shipped) but the browser front-end and the dashboard specs were never touched. A user opening the dashboard during a real v2 run sees:

- The synthesis overlay text *"clusters forming…"* (`web/index.html:1537`) — actively misleading because S2 replaced clusters with thesis-driven synthesis as the default. The DOM uses cluster-named CSS (`<div id="clusters">`, `.clusters`, `.cluster`).
- Events of the 10 new v2 kinds (`source.classified`, `fact.dropped.irrelevant`, `contract.drafted`, `contract.revised`, `gap.analyzed`, `thesis.drafted`, `claim.triangulated`, `section.rubric`, `section.dropped`, `synthesis.fallback`) rendering through the formatter but falling through `KIND_FAM` (web/index.html:1228) to the generic "iteration" family — no color coding, no filter category, all v2 work indistinguishable in the log.
- No state for v2 artifacts: no contract view, no thesis claims, no per-claim triangulation summary, no current synthesis substep. A fresh page-load of the dashboard mid-synthesis shows the v1 phase row and nothing else.
- Spec drift: `dashboard-server/spec.md` doesn't document the `endedAt` field that the server code already returns; `dashboard-ui/spec.md` references only v1 event categories.

This change brings the front-end and both dashboard specs in line with v2. Visualization / observability only; no agent behaviour or report quality touched.

## What Changes

- **MODIFIED** `dashboard-server`: three new endpoints + one documentation fix:
  - `GET /api/contract` returns the parsed contract from `run_state.contract_json` (or `null` when no run is active or the row's `contract_json` is null). Shape: `{core_question, sub_questions[], good_answer_contains[], out_of_scope[]} | null`.
  - `GET /api/synthesis-state` returns a structured snapshot of the v2 synthesis pipeline. Shape: `{substep: 'idle' | 'thesis-drafting' | 'triangulating' | 'writing' | 'editing' | 'stitching' | 'done' | 'fallback', thesisSentences: string[] | null, claims: Array<{headline, claim, corroborations, contradictions, contested}> | null, sectionsWritten: number, sectionsDropped: number, reportPath: string | null}`. Derived by reading the most-recent terminal events from `events.jsonl` (one cheap tail-scan per request).
  - `GET /api/report` returns the latest report (the file at `run_state.reportPath` or the most recent `.sheldon/reports/<runId>.md`) as `{path, html, sources}` where `html` is the markdown rendered to HTML with `[N]` citation tokens rewritten as `<a href="<url>" target="_blank">[N]</a>` based on the report's `## Sources` section. Returns `null` when no report exists.
  - Document the existing `endedAt` field in `/api/run-state` (currently in code, missing from spec). No behaviour change for this point — just spec sync.
- **MODIFIED** `dashboard-ui`:
  - `KIND_FAM` map gains 10 entries: `source.classified` → `'L3'`-flavoured (a sensible new family `"source"`), `fact.dropped.irrelevant` → `"fact"` (existing), `contract.drafted` / `contract.revised` → new `"contract"` family, `gap.analyzed` → new `"gap"` family, `thesis.drafted` / `claim.triangulated` / `section.rubric` / `section.dropped` / `synthesis.fallback` → `"synthesis"` family (already exists from v1; new kinds slot in). Each new family gets a CSS color row alongside the existing per-family palette.
  - Replace the *"clusters forming…"* overlay (and the cluster-named DOM/CSS around it) with a **v2-aware synthesis progress view**: a vertical step list (`thesis → triangulate → write → edit → stitch`) where the current substep is highlighted; per-step a small summary (thesis: claim count, triangulate: ✓/N triangulated, write: N/total written, edit: N dropped, stitch: report path on done). When `synthesis.fallback` has fired, the overlay shows a single `"Cluster fallback (reason: X)"` line instead of the substep tree.
  - **Dynamic synthesis headline + subtitle**: the `<h2>` and `<p>` at the top of the synth panel now reflect the current substep (`Drafting the thesis` / `Triangulating load-bearing claims` / `Writing sections` / `Brutal-editing weak sections` / `Stitching the final report` / `Report ready` / `Falling back to cluster synthesis`) instead of static placeholder text.
  - **Wire up the "by topic" filter** on the Facts panel. Currently the `recent` / `by topic` chips are inert decoration. After this change, clicking "by topic" re-renders the fact list grouped by `f.topic` (each group has a topic-coloured header chip + the facts under it). Clicking "recent" returns to the existing recency-sorted view. Default is "recent".
  - **Make the `+N in last iter` count live**. Currently the `#facts-count` next to the Facts title is the static string `"+22 in last iter"`. After this change, the dashboard listens for `iteration.end` SSE events and updates the count to the latest `payload.factsAdded` value.
  - **Add an in-browser report viewer**. When `phase === 'done'` and a report path is available, fetch `/api/report` and replace the synth panel's right-column content (sections list) with the rendered report HTML. Citations `[N]` in the rendered HTML are clickable links to the source URL (open in a new tab via `target="_blank" rel="noopener"`). Source list at the bottom is also rendered with the same target/rel.
  - DOM rename: `<div id="clusters">` → `<div id="synth-progress">`; CSS `.clusters` / `.cluster` → `.synth-substeps` / `.synth-substep` (with `.is-active` for the current step). Inline JS selectors updated accordingly.
  - On page load OR resume mid-run, hit `/api/contract` and `/api/synthesis-state` once for a snapshot; subsequently update from the SSE event stream (`contract.drafted` / `thesis.drafted` / `claim.triangulated` / `section.written` / `section.dropped` / `synthesis.fallback` / `report.written` / `iteration.end`).
  - **Additional CSS fixes** discovered during live testing: `.fact` no longer has `overflow: hidden` (was clipping `fact-foot` metadata behind a stale `max-height: 200px` from the entry animation); `.fact-claim` gains `overflow-wrap: anywhere; word-break: break-word;` (was overflowing on long unbreakable tokens); `body[data-phase="done"] .synth` now matches (the synth panel persists after the run completes — was hidden by `data-phase="done"` since the only show-rule targeted `synthesis`); `renderSynth` early-returns if its DOM nodes haven't mounted (prevents a silent JS throw during early page-load races).

Not BREAKING: existing endpoints unchanged in shape; new endpoints additive; the dashboard still renders on a run that produces no v2 events (cluster fallback path).

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `dashboard-server`: gains `/api/contract` and `/api/synthesis-state` endpoints. Existing `/api/run-state` spec updated to document the `endedAt` field already in code.
- `dashboard-ui`: event-family map extended for v2 kinds; cluster-named overlay replaced with synthesis-substep tree driven by the new endpoints + SSE; DOM/CSS renamed off cluster vocabulary.

## Impact

**Code**: `src/server.ts` (2 new route handlers + spec-sync doc nits), `web/index.html` (KIND_FAM map, synthesis overlay rewrite, DOM/CSS rename, JS to consume the new endpoints and SSE events for the substep tree). No new server modules. No agent code touched.

**APIs**: 2 new GET endpoints, both small read-only handlers. Existing endpoints unchanged.

**Run-time cost**: `/api/synthesis-state` does one tail-scan of `events.jsonl` per request (similar pattern to `/api/stats`); cheap early, slow on multi-hour runs (same trade-off the existing stats endpoint already accepted). `/api/contract` is one SQLite query.

**Dependencies**: assumes the v2-tuning archive is the current state of `src/events.ts`, `src/format.ts`, and the events SSE stream. No new packages.

**Risk**: synthesis-state derivation from events is heuristic — the substep is inferred from "latest seen kind" patterns, not from explicit run-state markers. If the agent's event ordering ever changes, the UI's substep can lag or report wrong substep briefly. Mitigation: idempotent per-event update logic; substep transitions are monotonic.

**Out of scope**: dashboard responsive design changes, dark/light theme overhaul, the missing `/api/sections` endpoint hinted by old code comments (not needed for the substep view), per-claim drill-down detail pages, multi-run history viewer.
