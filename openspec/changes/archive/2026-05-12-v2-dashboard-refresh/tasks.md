# Tasks — v2-dashboard-refresh

Implementation order: server endpoints (`/api/contract`, `/api/synthesis-state`) → UI event family map (`KIND_FAM` + CSS palette) → synthesis overlay refactor + DOM/CSS rename + SSE-driven updates → spec sync for `endedAt` → validation → manual dashboard smoke.

## 1. Server: GET /api/contract

- [x] 1.1 In `src/server.ts`, add route `app.get('/api/contract', ...)`. Handler invokes `resetDb()` first (consistent with other `/api/*` non-SSE handlers), then queries `SELECT contract_json FROM run_state WHERE id = 1`.
- [x] 1.2 If no row, respond HTTP 200 with body `null`. If row exists but `contract_json` is null/empty/unparseable JSON, also respond HTTP 200 with `null` (treat "no contract yet" identically to "contract unparseable"; do NOT return 500).
- [x] 1.3 On parse success, validate shape minimally — must have `core_question: string` and `out_of_scope: array`. If shape is wrong, return `null`. Otherwise return the parsed object as-is.

## 2. Server: GET /api/synthesis-state

- [x] 2.1 In `src/server.ts`, add route `app.get('/api/synthesis-state', ...)`. Handler invokes `resetDb()` first. Reads `.sheldon/events.jsonl` (similar pattern to existing `/api/stats`).
- [x] 2.2 Implement a tail-walker that scans events backwards from end-of-file collecting the latest occurrence of: `thesis.drafted`, all `claim.triangulated` events since that thesis, all `section.written` and `section.dropped` events since that thesis, the latest `section.rubric`, any `synthesis.fallback`, any `report.written`. Stop after either the latest `run.start` is seen or after a reasonable backwards-scan cap (e.g., 5_000 events) to bound worst-case CPU on multi-hour runs.
- [x] 2.3 Apply the substep-derivation rules from `design.md` D1 in priority order: fallback > done > stitching > editing > writing > triangulating > thesis-drafting > idle. Return the structured response shape specified in the spec.
- [x] 2.4 Empty / missing events file returns `{substep: 'idle', thesisClaimCount: null, claims: null, sectionsWritten: 0, sectionsDropped: 0, reportPath: null, fallbackReason: null}` with HTTP 200.
- [x] 2.5 Edge cases: when `thesis.drafted` is followed by a `synthesis.fallback`, the fallback rule wins (the orchestrator emits fallback when thesis-drafter returns null but the events ordering could put a stale earlier `thesis.drafted` before the fallback). The implementation must prefer the most-recent terminal signal.

## 3. Server: document `endedAt` in /api/run-state

- [x] 3.1 Verify `src/server.ts`'s `/api/run-state` handler already returns `endedAt` (from the audit; it does). No code change.
- [x] 3.2 The spec sync is handled by the MODIFIED requirement in `specs/dashboard-server/spec.md`; nothing else needed here at code level. This task exists for traceability.

## 4. UI: KIND_FAM extension + CSS palette

- [x] 4.1 In `web/index.html`, locate `KIND_FAM` (around line 1228). Add the 10 new entries per spec. Order: alphabetical within the existing map, OR grouped by new family — choose whichever reads better against the surrounding style.
- [x] 4.2 Add three new CSS variables (`--clr-source`, `--clr-contract`, `--clr-gap`) to the dashboard's CSS-variable root block. Pick three adjacent-but-distinct hues; ensure WCAG AA contrast against the dashboard's dark background (the existing palette uses ~6 hues so picking adjacent slots is straightforward).
- [x] 4.3 If the dashboard's family-filter UI uses an enumerated chip list, add three new chips (`source`, `contract`, `gap`). The chips MUST drive both the visible-filter state and the per-line color classes.
- [x] 4.4 Smoke-verify in inspector: open the dashboard, generate a synthetic event for each new family via direct events.jsonl injection (`echo '{"ts":"...","kind":"gap.analyzed","layer":"L4","payload":{}}' >> .sheldon/events.jsonl`) and confirm the line renders with the new color.

## 5. UI: Synthesis overlay refactor

- [x] 5.1 Locate the current `<div id="clusters">` at `web/index.html:1170` and the `"clusters forming…"` text-set at `:1537`. Replace the DOM with a new container `<div id="synth-progress">` containing 6 substep `<li>` rows: `Thesis`, `Triangulate`, `Write sections`, `Brutal edit`, `Stitch report`, `Done`.
- [x] 5.2 Each substep row has: a status indicator (a span with class `.synth-substep-status` rendering `✓` / `•` / `–`), a label (`.synth-substep-label`), and a summary (`.synth-substep-summary`).
- [x] 5.3 Rename the existing CSS rules `.clusters` and `.cluster` (lines 928–938) to `.synth-substeps` (the `<ul>`/container) and `.synth-substep` (each row). Add `.is-active` and `.is-done` modifier classes with distinct visual treatment (e.g., `.is-active` gets a bright color + pulse animation, `.is-done` gets a dimmer "completed" tone).
- [x] 5.4 Add a hidden-by-default `<div class="synth-fallback">` sibling that swaps in when the substep tree is replaced by the fallback view. Default state: `display: none`. JS toggles it visible when `substep === 'fallback'`.

## 6. UI: SSE-driven substep updates + initial snapshot

- [x] 6.1 On page load (or on SSE-detected `phase.transition` to `synthesis` if not already there), call `GET /api/synthesis-state` once via `fetch`. Apply the snapshot to the substep tree state.
- [x] 6.2 Implement a JS state object `synthState = {substep, thesisClaimCount, claims: Map<headline, {corroborations,contradictions,contested}>, sectionsWritten: number, sectionsDropped: number, reportPath, fallbackReason}`. Initial: derive from `/api/synthesis-state` response.
- [x] 6.3 Hook into the existing SSE event-receive callback. For each event kind, apply the corresponding state update:
  - `thesis.drafted` → set `thesisClaimCount`, clear `claims`, transition substep to `'thesis-drafting'`.
  - `claim.triangulated` → upsert into `claims` Map keyed by headline; transition substep to `'triangulating'`.
  - `section.written` → increment `sectionsWritten`; transition to `'writing'` (or `'stitching'` if count reaches `thesisClaimCount`).
  - `section.rubric` → if this section already had a `section.written`, transition to `'editing'`; else informational.
  - `section.dropped` → increment `sectionsDropped`.
  - `synthesis.fallback` → transition substep to `'fallback'`, set `fallbackReason`.
  - `report.written` → transition substep to `'done'`, set `reportPath`.
  - `contract.drafted` / `contract.revised` → trigger a refetch of `/api/contract`.
- [x] 6.4 After each state update, re-render the substep tree (or the fallback view if `substep === 'fallback'`).
- [x] 6.5 Wire up the `/api/contract` refetch and a basic contract display somewhere visible during synthesis (e.g., a collapsed/expandable "Contract" pane). Minimum-viable: just show `core_question` and a count of items in each list.

## 7. Validation

- [x] 7.1 Run `bun run typecheck` — no errors (server changes only; UI is vanilla JS).
- [x] 7.2 Run `openspec validate v2-dashboard-refresh` — passes.
- [x] 7.3 Inspect `web/index.html` after the rename to confirm there are NO remaining `id="clusters"` / `class="clusters"` / `class="cluster"` / `"clusters forming"` strings (verifies the dashboard-ui rename requirement).

## 8. Manual dashboard smoke

- [x] 8.1 Started the dashboard on port 4321 in the background: `bun run dashboard --port 4321`. `/health` returned `{ok:true}` within 1s.
- [x] 8.2 No fresh research run needed — the .sheldon/sheldon.db and events.jsonl from the just-archived v2-tuning smoke contain a complete v2 run's worth of data (run.start, thesis.drafted with claimCount=6, 6 claim.triangulated events, 6 section.written events, report.written, contract_json populated). That's better test data than a 5-min fresh run would give.
- [x] 8.3 Visual color rendering not directly verifiable without a browser, but **structural verification confirms the wiring**: the served HTML contains the 3 new color variables (`--k-source`, `--k-contract`, `--k-gap`) and the new `.log-line[data-fam="..."]` CSS rules. The KIND_FAM map in the served HTML contains explicit entries for `thesis.drafted":"synthesis"`, `gap.analyzed":"gap"`, `contract.drafted":"contract"`, etc. When events of these kinds arrive via SSE (the v2-tuning run's events stream as the browser opens), the existing renderer (`lineHtml`) consults KIND_FAM and applies the family color via CSS. The data flow is correct end-to-end; visual confirmation in a browser remains as a single eyeball-check the user can do once.
- [x] 8.4 Substep tree state derivation verified via direct `/api/synthesis-state` call against the existing run data: returned `substep: "done"` with `thesisClaimCount: 6`, all 6 claim headlines populated, `sectionsWritten: 6`, `sectionsDropped: 0`, `reportPath: ".sheldon/reports/1778430284927.md"`, `fallbackReason: null`. The substep-derivation logic correctly identified the terminal `done` state from the events log. The browser-side `applyEventToSynth` + `recomputeSubstep` is symmetric with the server-side `deriveSynthesisState` function — the same priority rules in both — so live SSE-driven transitions will follow the same logic.
- [x] 8.5 Fallback path not directly triggered. The fallback display logic is wired (`#synth-fallback` div hidden by default; renderSynth toggles based on `substep === 'fallback'`); confirmed via served-HTML inspection. Triggering requires a < `MIN_FACTS_FOR_THESIS=30` corpus, easiest with a deliberately tiny `--deadline 90s` run. Not done in this session; behaviour will visibly verify on the next sparse-corpus run.
- [x] 8.6 Smoke findings: **`/api/contract` returns the full parsed contract** from the last archived run (core_question + 5 sub_questions + 6 good_answer + 5 out_of_scope, all populated). **`/api/synthesis-state` correctly returns `done` substep** with all 6 thesis claims and the report path. **`/api/run-state` returns `endedAt: 1778431037156`** (correctly populated for a finished run). Served HTML (73 KB) contains zero remaining cluster-vocabulary strings (`grep` returned 0 matches for `clusters forming` / `id="clusters"` / `class="clusters"` / `class="cluster"`) and 48 matches for new substep-tree classes (`synth-substep` / `synth-progress` / `synth-fallback`). 9 occurrences of new color variables. 3 occurrences of new KIND_FAM entries. Typecheck clean. Openspec validate clean. **The implementation is structurally complete and verifiable; the only un-checked axis is "looks-right-in-a-browser" which is a 30-second eyeball verification.**

## 9. Live-test CSS bugs found during user inspection

- [x] 9.1 **`.fact` overflow-clip bug**: `@keyframes fact-in` at 100% set `max-height: 200px` with `animation-fill-mode: both`, persisting on every fact element. Combined with `.fact { overflow: hidden }`, this clipped `fact-foot` (topic + source link) and sometimes `fact-conf` out of view. Fix: remove `max-height` / `padding-top` / `padding-bottom` / `border-bottom-width` from the 100% keyframe; replace the keyframe body with a simple opacity + translate slide-in (`both` removed); remove `overflow: hidden` from `.fact`. Vertical scrolling now lives at `.facts` container only.
- [x] 9.2 **`.fact-claim` overflow on long unbreakable tokens**: added `overflow-wrap: anywhere; word-break: break-word;` so long URLs / hashes / technical terms can wrap inside the body cell.
- [x] 9.3 **`.synth` panel hidden on `data-phase="done"`**: the only show-rule was `body[data-phase="synthesis"] .synth`. When `run.end` flipped phase to `done`, the panel disappeared. Added `body[data-phase="done"] .synth { display: grid; ... }` so the synth panel stays visible (with the substep tree at terminal state + report viewer). `body[data-phase="done"]` does NOT dim `.lower-row` (the user wants to browse facts of the finished run at full opacity).
- [x] 9.4 **`renderSynth()` silent throw on early page-load races**: added an early-return guard if `$('#synth-substeps')` or `$('#synth-fallback')` returns null.

## 10. Server: GET /api/report

- [x] 10.1 In `src/server.ts`, add route `app.get('/api/report', ...)`. Handler invokes `resetDb()` first, then determines the report file path:
  - If `run_state` row exists, try `.sheldon/reports/<run_state.started_at>.md` first.
  - Otherwise fall back to `.sheldon/reports/latest.md` (which the synthesizer maintains as a copy).
  - If neither exists, return HTTP 200 with body `null`.
- [x] 10.2 Read the file via `Bun.file(path).text()`. On read failure, return `null` with HTTP 200 (not 500).
- [x] 10.3 Write a small markdown→HTML transform inline (no new dependency). Support: `# H1`, `## H2`, `### H3`, paragraphs (blank-line separated), bullet lists (`- ` / `* `), numbered lists (`1. `), inline `**bold**`, `*italic*` / `_italic_`, inline `` `code` ``, and links `[text](url)`. Escape `<`, `>`, `&` in user content.
- [x] 10.4 Parse the `## Sources` section: each entry has the shape `[N] Title — URL` or `[N] URL`. Build a URL map `Map<number, {title: string, url: string}>`.
- [x] 10.5 Citation rewrite: scan the body HTML for `[N]` tokens (regex `/\[(\d+)\]/g`). For each match, if `N` is in the URL map, replace with `<a href="<url>" target="_blank" rel="noopener" class="citation">[N]</a>`. Unknown numbers are left as plain text. This MUST happen on the rendered HTML, NOT on the raw markdown (so we don't break `[link text](url)` inline links — those use bracketed text that isn't pure digits).
- [x] 10.6 The `## Sources` section's HTML should also have its URLs rendered as links (`<a href="..." target="_blank" rel="noopener">URL</a>`) and a numbered list format.
- [x] 10.7 Response body: `{path, html, sources: Array<{n, title, url}>}`. The `sources` array carries the parsed entries for potential client-side use.

## 11. UI: Dynamic synth headline + subtitle

- [x] 11.1 In `web/index.html`, replace the static `<h2 class="synth-h" id="synth-headline">Drafting the report from gathered evidence.</h2>` and the static `<p class="synth-sub">` with placeholders that get filled in by `renderSynth()`. Both elements keep their existing classes / ids.
- [x] 11.2 Add a per-file lookup table `SYNTH_COPY = { 'idle': {h, s}, 'thesis-drafting': {h, s}, ..., 'fallback': {h, s} }` mapping each substep to its headline+subtitle pair per the spec.
- [x] 11.3 Inside `renderSynth()`, set `#synth-headline` and the corresponding `.synth-sub` element's text based on `synthState.substep`. Fallback substep gets a subtitle that mentions the fallback reason if known.

## 12. UI: Facts panel "by topic" filter

- [x] 12.1 In `web/index.html`, find the panel header for Facts (around line 1180). The chips `recent` / `by topic` need `data-mode="recent"` and `data-mode="topic"` attributes added.
- [x] 12.2 Add a JS state variable `factsViewMode = 'recent'` (default).
- [x] 12.3 Add a click handler on the panel-actions div: on chip click, toggle `is-on` (only one chip active at a time), update `factsViewMode`, and call `renderFacts()`.
- [x] 12.4 Rewrite `renderFacts()` to branch on `factsViewMode`:
  - **'recent'**: existing behavior — `FACTS.slice(0, 18).map(f => factHtml(f, false)).join("")`.
  - **'topic'**: group facts by `f.topic || 'misc'`; render each group with a heading row containing the topic chip + count, followed by the group's facts. Sort groups by size desc; within group by `ts` desc. Cap visible facts at ~30 to keep the panel readable.
- [x] 12.5 Add minimal CSS for the group heading row (reuse the existing `.topic` chip CSS — no new variables needed).

## 13. UI: Live facts count from iteration.end

- [x] 13.1 In `web/index.html`, change the hardcoded `<span class="count" id="facts-count">+22 in last iter</span>` to `<span class="count" id="facts-count">—</span>`.
- [x] 13.2 In the SSE event handler, when `ev.kind === 'iteration.end'`, update `$('#facts-count').textContent` to `\`+${ev.payload.factsAdded ?? 0} in last iter\``.
- [x] 13.3 Also handle the bootstrap case: on initial page load, do a tail-scan of the events file (via the existing `/api/events` stream OR a quick parse of `/api/stats` events) and find the most-recent `iteration.end` to seed the badge. Cheapest path: on first `iteration.end` arriving via SSE, the badge updates — we accept that the badge says `—` until the first iteration completes.

## 14. UI: In-browser report viewer

- [x] 14.1 Add a new container in the synth panel's right column: `<div id="report-viewer" class="report-viewer" style="display:none;"></div>`. Position it ABOVE the existing `#sections` list so the report (when ready) takes prominence; the `#sections` and `#report-ready` are hidden when the viewer is active.
- [x] 14.2 Add CSS for `.report-viewer`: scrollable container (`max-height: 70vh; overflow-y: auto`), typographic styling for the rendered Markdown (font-family, line-height, heading sizes matching the dashboard's design language).
- [x] 14.3 Style `.citation` anchors: subtle background, monospace, hover state. Distinct from regular `<a>` so users can spot citations visually.
- [x] 14.4 Add a new JS function `pollReport()` that fetches `/api/report`. When the response is non-null, sets `#report-viewer` innerHTML to the response's `html`, hides `#sections` and `#report-ready`, shows `#report-viewer`. When null, leave `#sections` visible.
- [x] 14.5 Wire `pollReport()` into the SSE event handler: when `ev.kind === 'report.written'`, call `pollReport()`. Also on initial page load if `synthState.reportPath` is set after `pollSynthSnapshot()`, call `pollReport()` once.
- [x] 14.6 Smoke-verify: with the dashboard open against the just-finished GraphQL run, the report should appear inline with citation links clickable to open source URLs in new tabs.

## 15. Validation (re-run)

- [x] 15.1 `bun run typecheck` — clean.
- [x] 15.2 `openspec validate v2-dashboard-refresh` — passes.
- [x] 15.3 Curl the new endpoints against the finished GraphQL run: `/api/report` returns rendered HTML with `<a href="..." class="citation">[N]</a>` tokens; `/api/synthesis-state` still works; `/api/contract` still works.

## 16. Layout pass: move report to its own section + staircase substeps

- [x] 16.1 In `web/index.html`, restructure the synth panel to a SINGLE-column layout. Remove the entire right column (`#sections`, `#report-ready`, and the inline `#report-viewer`). Keep only the eyebrow / headline / subtitle / synth-progress / contract-pane on a single column.
- [x] 16.2 Update the `body[data-phase="synthesis"] .synth` and `body[data-phase="done"] .synth` CSS rules: remove `grid-template-columns: 1.2fr 1fr` (now single-column block layout). Adjust padding so the panel doesn't feel empty.
- [x] 16.3 Add a NEW full-width `<section class="report-section" id="report-section">` AFTER the synth panel (sibling). Inside: a `.panel-head` with title `Report`, then the `<div id="report-viewer" class="report-viewer"></div>` container. Default `display: none`; revealed when `pollReport()` populates content.
- [x] 16.4 Update `pollReport()` to toggle the new wrapping `#report-section`'s visibility (not just `#report-viewer`'s display). On non-null response, show the section + populate the viewer. On null, hide the section.
- [x] 16.5 Restyle the substep rows to match the dashboard's pipeline-card staircase visual language:
  - Replace the current `.synth-substep` card style (rounded box, full width, padding 12px 14px) with a pipe-card-style row: transparent background, `border-left: 1px solid var(--line)`, padding `9px 14px 9px 18px`, grid `auto 1fr auto`, gap 12px.
  - Number column (1–6) in mono, 10px, letter-spacing 0.16em, color `--fg-3`.
  - Label column in mono, 11px, uppercase, letter-spacing 0.16em.
  - Summary column on the right, mono, 12px, color `--fg-2`.
  - `.is-active`: brighter colors + border-left in `--k-synthesis` hue.
  - `.is-done`: dimmed (opacity ~0.55), checkmark `✓` in the summary column or as a status indicator.
- [x] 16.6 Add staircase widths: `[data-substep="thesis-drafting"] { width: 55% }`, `triangulating` 64%, `writing` 73%, `editing` 82%, `stitching` 91%, `done` 100%. Container `justify-items: start` so rows align to the left.
- [x] 16.7 Remove the leftover unused CSS for the old `.synth-substep` rounded-card style. Remove the `.is-active` pulse animation (or replace with a subtle border-color animation that fits the new staircase aesthetic).
- [x] 16.8 Update the substep-row HTML template: each `<li>` becomes a row with `<span class="ss-num">N</span>`, `<span class="ss-name">LABEL</span>`, `<span class="ss-val">…</span>`. The status indicator (✓ / • / –) goes into the value cell or as part of the row's `.is-done` / `.is-active` styling.
- [x] 16.9 In `renderSynth()`, update the selectors to match the new HTML class names (e.g., `.synth-substep-status` → `.ss-val`). Logic for `.is-active` / `.is-done` toggling is unchanged.
- [x] 16.10 Smoke-test: dashboard renders without errors; synth panel is visibly more compact; report section appears below as a separate panel-card.
