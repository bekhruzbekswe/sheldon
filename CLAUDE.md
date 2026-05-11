# Sheldon — workflow

Full orientation in [`AGENTS.md`](./AGENTS.md). System shape in [`docs/architecture.md`](./docs/architecture.md). Below is the operational essentials.

## The five artifacts and what each owns

- **`docs/architecture.md`** — source of truth for **system shape**. What the layers are, how they fit, what the invariants are. Updated only when the *shape* changes (new layer, new cross-cutting rule, new data store). Rare.
- **`openspec/specs/<capability>/spec.md`** — source of truth for **behavior**. Per-capability contract: what each module accepts, returns, persists. Granular. Updated by archiving openspec changes (auto-sync), not by hand-edit.
- **`openspec/changes/<name>/`** — **the workspace**. Where in-flight work lives: proposal (why), design (how), specs delta (what changes contractually), tasks (the checklist). One change = one implementable unit.
- **`openspec/changes/archive/<date>-<name>/`** — **history**. Frozen record of what shipped and when. The audit trail.
- **`docs/initiatives/<name>.md`** — **intent, pre-openspec**. Bird's-eye write-up of a multi-change effort that hasn't been formalized yet. Optional — small work skips this and goes straight to openspec.

## How we work

1. **New work shows up.** Decide one or many.
   - One implementable unit (1–2 days, one capability touched) → skip to step 3.
   - Multi-week effort touching several capabilities → write `docs/initiatives/<name>.md` first. Answers *why*, *what changes if it ships*, *out of scope*, *open questions*. Orientation, not spec.

2. **Promote each implementable chunk to openspec.** `openspec new change <name>` (or `/opsx:new <name>`). Write proposal/design/specs-delta/tasks *against current reality* — the initiative doc is reference, not a copy source. The system may have moved since the doc was written.

3. **Implement.** `/opsx:apply <name>` walks the tasks; mark each `[x]` as it lands. Pause on ambiguity, don't guess.

4. **Validate.** `openspec validate <name>` (or `/opsx:verify`) before archiving. A spec that doesn't pass validation will mislead future sessions. Also run `bun run typecheck`.

5. **Ship.** `/opsx:archive <name>` syncs the specs delta into `openspec/specs/` (the spec is now true again) and moves the change to `archive/`. If the change came from an initiative doc, trim or delete the doc — its job is done.

6. **If the system's shape changed,** update `docs/architecture.md`. This is rare and deliberate. Most changes don't move the shape — they refine behavior within it.

## Decision points

- *Initiative vs straight-to-openspec?* If you can write one `proposal.md` and one `tasks.md` for the whole thing, skip the initiative. If you need to sequence 3+ changes, write the initiative first.
- *Update architecture.md or specs?* Architecture = "what kind of system is this." Specs = "what does this capability do." If you'd describe the change as "we have a new layer" or "we changed how layers interact," that's architecture. Otherwise it's specs.
- *Initiative still relevant after preceding work shipped?* Re-read before promoting. If reality moved, rewrite or delete first. Stale planning docs are worse than no planning docs.
