# Design — v2-dashboard-refresh

## Context

The L8 dashboard (Hono server + SSE + vanilla-JS browser UI) was built for v1 — a search loop that gathers facts, k-means-clusters them, and writes one section per cluster. v2 shipped four changes (S1 + S2 + S3 + v2-tuning) that added 10 new event kinds, a research contract artifact, source classification, thesis-driven synthesis, claim triangulation, brutal-editor pass, gap analysis at phase boundaries, and contract revision. The server-side formatter (`src/format.ts`) was updated as each stage shipped — events render with friendly summaries. The browser front-end was not. This change fixes the browser-side staleness and adds the minimum server endpoints needed for a fresh page-load to see meaningful v2 state.

Scope is deliberately bounded to observability. No agent behaviour, no quality work, no new capabilities. Existing endpoints stay backwards-compatible; new endpoints are additive.

## Goals / Non-Goals

**Goals:**

- v2 events render with correct family/color/filter category in the dashboard log stream.
- The synthesis-phase overlay accurately reflects which substep is currently running (thesis-drafting / triangulating / writing / editing / stitching), and visibly switches to a "cluster fallback" indicator when `synthesis.fallback` fires.
- A fresh page-load of the dashboard mid-run shows the contract (if drafted) and the current synthesis substep snapshot — events alone aren't enough on cold load.
- Specs and code stay in sync: document the existing `endedAt` field, write specs for the new endpoints, update dashboard-ui spec for the v2 event families.
- Cluster-vocabulary DOM / CSS renamed to neutral names so v1 baggage doesn't accumulate.

**Non-Goals:**

- Visual / theme redesign (light / dark mode polish, layout responsiveness).
- Multi-run history view, per-claim drill-down pages, per-source drill-down pages.
- An `/api/sections` endpoint that the old code comment hinted at (the substep tree gives enough resolution without it).
- Streaming `synthesis-state` over SSE (the snapshot endpoint + listening to existing SSE event kinds is enough).
- Backwards compatibility with v1-only runs that don't emit any v2 events — the substep tree just shows nothing for those, which is correct.

## Decisions

### D1. Derive `/api/synthesis-state` substep from event-log tail, not new persistent state

**Choice:** the server tails `events.jsonl` (similar to how `/api/stats` already does) and walks backwards from the end, looking for the most-recent terminal kinds:

| Substep returned | Triggering event pattern |
|---|---|
| `'idle'` | no relevant synthesis events seen yet |
| `'thesis-drafting'` | `thesis.drafted` seen, no later `claim.triangulated` or section events |
| `'triangulating'` | at least one `claim.triangulated`, no later `section.written` |
| `'writing'` | at least one `section.written`, no later `section.rubric` for a different headline, not yet at stitching |
| `'editing'` | `section.rubric` seen for at least one section after its initial `section.written`, before `report.written` |
| `'stitching'` | `section.written` count ≥ thesis.claimCount, no `report.written` yet |
| `'done'` | `report.written` present |
| `'fallback'` | `synthesis.fallback` present anywhere in the synthesis sub-trace |

These transitions are monotonic in practice — the agent doesn't go backwards through synthesis. The substep is "best guess from observation" and can momentarily mis-classify a brief gap between events; not a correctness issue because the UI also listens to live SSE and updates as new events arrive.

**Alternatives:**

- *Persist current substep on `run_state`.* Rejected: adds a column for telemetry, and the agent would have to update it on every transition. The event log already captures this.
- *Stream `synthesis-state` over SSE.* Rejected: the existing SSE channel already carries every event we need; layering a derived stream on top is duplicate plumbing. Snapshot endpoint + per-event UI logic is sufficient.

**Rationale:** matches the existing pattern (`/api/stats` also derives from `events.jsonl`). Zero new persistent state. Page-refresh-safe.

### D2. Thesis claims surface via the latest `thesis.drafted` event payload

**Choice:** `/api/synthesis-state` returns thesis claim metadata derived by scanning the events log for the most-recent `thesis.drafted` event AND the most-recent `claim.triangulated` event per claim headline. Walks the tail of `events.jsonl` once per request.

The `thesis.drafted` event currently has payload `{claimCount, thesisSentenceCount, factSliceSize, facts_per_domain_cap}` — counts only, not the actual claim text. So this endpoint can only return claim *headlines* + triangulation metadata, not the full thesis sentences. The `claim.triangulated` event has `{claimHeadline, corroborations, contradictions, contested, queriesRan, error?}` which is enough for the per-claim row in the UI.

For the thesis sentences themselves: the UI must derive from the eventual report text via `/api/report` (no such endpoint exists today; see Open Questions). For this change, the UI shows headlines only in the overlay; the full thesis remains in the rendered report. Acceptable.

**Alternatives:**

- *Extend `thesis.drafted` payload to include full claims.* Rejected: payload bloat, and it's mutable per-run state not telemetry. The report file is the source of truth for thesis text.
- *Add a transient in-memory thesis store on the agent side that the dashboard queries.* Rejected: cross-process IPC complexity. Events are the contract.

**Rationale:** dashboards always serve a derived view; the event log is sufficient.

### D3. `KIND_FAM` extension assigns three new families (`source`, `contract`, `gap`), reuses two existing (`fact`, `synthesis`)

**Choice:** the 10 new v2 event kinds map to:

```js
const KIND_FAM = {
  // ...existing v1 entries...
  'source.classified':       'source',
  'fact.dropped.irrelevant': 'fact',         // reuses existing fact family
  'contract.drafted':        'contract',
  'contract.revised':        'contract',
  'gap.analyzed':            'gap',
  'thesis.drafted':          'synthesis',    // reuses existing synthesis family
  'claim.triangulated':      'synthesis',
  'section.rubric':          'synthesis',
  'section.dropped':         'synthesis',
  'synthesis.fallback':      'synthesis',
};
```

Three new families need new CSS color rows. Suggested palette extension (the existing palette uses ~6 distinct hues): pick three more that contrast well in both light and dark modes. Implementation will use existing CSS-variable naming conventions; pick `--clr-source`, `--clr-contract`, `--clr-gap` for the new variables.

**Alternatives:**

- *Single new family `"v2"` for everything new.* Rejected: defeats the purpose of family-level filtering. A user wants to filter for "show me only contract events" or "show me only gap analysis", not "show me v2".
- *Map `fact.dropped.irrelevant` to a new `"gate"` family.* Considered. Rejected: family semantics should be "what subsystem produced this", not "what action did it take". The fact-store produced it; "fact" family is correct.

**Rationale:** each family corresponds to a real conceptual area a user might want to drill into; three new is the right granularity.

### D4. Synthesis overlay is a step-tree, not a progress bar or pipeline diagram

**Choice:** vertical list of substeps in display order with an `.is-active` class on the current one and `.is-done` on completed ones:

```
Thesis              ✓   6 claims drafted
Triangulate         •   3/6 triangulated (in progress)
Write sections      –
Brutal edit         –
Stitch report       –
```

When `synthesis.fallback` is the latest synthesis-class event, replace the entire tree with one row: `Cluster fallback (reason: <reason>) — N sections being written`.

**Alternatives:**

- *Horizontal progress bar.* Rejected: substeps aren't equal-cost (triangulation is the dominant time spend), and a bar implies continuous progress that we don't measure.
- *Mermaid-style pipeline diagram.* Rejected: visually heavier; doesn't show progress through time well; harder to keep in sync with what the agent is actually doing.

**Rationale:** the user wants to know "what's happening right now and what's still ahead". A linear step-tree is the most direct read of that.

### D5. Snapshot-on-load + SSE-driven updates (no synthesis-state polling)

**Choice:** on page load, the UI calls `/api/contract` and `/api/synthesis-state` once. After that, it listens to the existing `/api/events` SSE stream for live updates:

- `contract.drafted` / `contract.revised` → refetch `/api/contract` (rare; ≤3 per run)
- `thesis.drafted` → update substep to `'thesis-drafting'` → `'triangulating'`-on-first-`claim.triangulated`
- `claim.triangulated` → update the per-claim row, increment triangulated count
- `section.written` → update section count, transition substep when count reaches claim count
- `section.dropped` → update dropped count
- `report.written` → substep `'done'`
- `synthesis.fallback` → substep `'fallback'`, swap UI to fallback row

Polling `/api/synthesis-state` more than once is unnecessary; the SSE stream carries everything the UI needs after the initial snapshot.

**Alternatives:**

- *Poll `/api/synthesis-state` every 2s like the existing `/api/run-state` polling.* Rejected: redundant with the SSE event channel; doubles request load on the server for no new information.

**Rationale:** the existing dashboard already uses snapshot-on-load + SSE-updates as its pattern for the event stream and the fact list. This is the same shape.

## Risks / Trade-offs

- **Risk:** `/api/synthesis-state` mis-classifies substep transiently when an event-class boundary is close to the page-load moment. → **Mitigation:** the heuristic is best-effort; the UI re-derives on every SSE event so any miss is corrected within seconds. Wrong substep for ~1s on cold load is acceptable.
- **Risk:** Per-request tail-scan of `events.jsonl` grows linearly with run length. On a 4-hour run with ~30K events, scanning back from end-of-file to find the latest 6–10 events of specific kinds is still O(thousands-of-lines-read-from-tail) on every dashboard fresh-load. → **Acceptable:** `/api/stats` already accepts this trade-off; same shape. If perf becomes a problem, both endpoints get the same optimization later (e.g., maintain a cursor of "events seen during this run" on `run_state` and seek to that position).
- **Risk:** Renaming `<div id="clusters">` and CSS classes silently breaks anything (e.g., a hand-built bookmarklet, an external script) targeting those names. → **Acceptable:** dashboard is a single-user observability surface; no external integrations. Internal selectors are all updated together in one diff.
- **Risk:** The substep-derivation rules in D1 don't cover the brutal-editor revision case neatly — `section.rubric` can fire twice for the same headline (first pass + revision), and the substep heuristic may classify the second rubric as "editing" while the first rubric is still part of "writing". → **Acceptable:** the substep classifications are coarse; the UI shows section counts as ground truth.
- **Trade-off:** the dashboard still doesn't show "what the LLM is doing right now" at a sub-event resolution (e.g., "extracting chunk 3 of 7 from URL X"). Out of scope; the SSE event stream covers per-event activity at the speed events arrive.

## Migration Plan

No DB schema changes. No new tables, no new columns. Roll-forward: drop the new code in; the dashboard's existing endpoints stay backwards-compatible. Rollback: `git revert`. No state corruption pathway.

## Open Questions

- **Should the dashboard read the rendered report file** for full thesis sentences once `report.written` fires? Tempting (gives the UI access to the full thesis prose), but adds a file-read endpoint and report-parsing logic. Defer until there's a real user need; for now the overlay shows headlines only and the user can click through to the report file via the existing "report written" line in the event log.
- **Should `synthesis.fallback` events also flow through `KIND_FAM`'s `"synthesis"` family or get their own `"fallback"` family?** Currently planned: `"synthesis"` (it IS a synthesis-phase event). The fallback path is visually distinguished in the overlay itself, not in the event log.
- **Should the substep tree show the gap-analysis steps that happen at phase boundaries?** The gap analyzer fires twice per run (breadth→depth, depth→synthesis); it's not strictly synthesis substep work but it's adjacent. Probably show "Gap analysis" rows as separate boundary markers between phases, not inside the synthesis tree. Decide at implementation time based on what reads well.
- **Color palette for the three new families** — exact hue choices defer to implementation. Use existing CSS variable patterns and pick adjacent-but-distinct hues that pass WCAG AA contrast against the existing dashboard background.
