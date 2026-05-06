# Layer plans

Each file in this directory sketches a future layer **before** it becomes an active openspec change. The shape is intentionally light — enough for a future session to understand intent, not so much that it becomes a stale spec.

When we reach a layer:

1. Read the file here for orientation.
2. Run `/opsx:new <layer-name>` (or `openspec new change <layer-name>`) to scaffold the real change.
3. Author the artifacts (proposal, specs, design, tasks), borrowing from the doc here but **updating against current reality** (what L3 actually shipped affects how L4 is built).
4. After the change is archived, leave the doc here as historical context — or replace it with a one-liner pointing at the archived change. Don't delete; the planning thought process is useful audit trail.

## Index

- [L1 — visibility primitive (event log)](./L1-event-log.md)
- [L2 — single search loop](./L2-search-loop.md)
- [L3 — fact store](./L3-fact-store.md)
- [L4 — frontier queue](./L4-frontier-queue.md)
- [L5 — time budget + phases](./L5-phase-machine.md)
- [L6 — synthesis](./L6-synthesis.md)
- [L7 — resume + crash recovery](./L7-resume.md)
- [L8 — live dashboard *(optional)*](./L8-dashboard.md)

## Conventions for layer docs

Each layer doc has these sections:

- **Goal** — one paragraph
- **Capabilities introduced** — kebab-case names (will become `openspec/specs/<name>/`)
- **Dependencies** — earlier layers/capabilities that must already exist
- **Key data structures / decisions** — sketches; will be firmed up in openspec design.md when promoted
- **Out of scope** — explicit list of what does *not* belong in this layer
- **Open questions** — things we deferred deciding until promotion time
