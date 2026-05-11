# Stage plans

Each file in this directory sketches a future **quality stage** for Sheldon **before** it becomes an active openspec change. Same shape and intent as `docs/layers/`, but for the post-v1 work.

L1–L8 in `docs/layers/` were *additive* — each layer added a capability the next stood on. The stages here are *corrective* — they sharpen the quality of what L0–L8 already produces, after evaluating real reports.

When we reach a stage:

1. Read the file here for orientation.
2. Run `openspec new change <stage-name>` (the suggested kebab-case name is at the bottom of each stage doc).
3. Author the artifacts (proposal, specs, design, tasks), borrowing from the doc here but **updating against current reality** (what the previous stage actually shipped affects how the next is built).
4. After the change is archived, leave the doc here as historical context — or replace it with a one-liner pointing at the archived change. Don't delete; the planning thought process is useful audit trail.

## Why these stages exist

After Sheldon v1 (L0–L8) shipped, two reports were generated for the same question — *"What are the pain points of outsourcing companies in AI age?"* — and evaluated against the bar of "what a smart, opinionated analyst would write after 4 hours."

- **Report A** — 19.4 min, 10 iterations, 266 facts, 10 sections. (`.sheldon/reports/1778049034961.md`)
- **Report B** — 35.4 min, 18 iterations, 697 facts, 8 sections. (`.sheldon/reports/1778051386986.md`)

Both fall short of the bar. Symptoms (off-topic sections, slug headings, transitional padding, single-source over-reliance, vendor marketing weighted equally with rigorous sources, no thesis) trace back to a unifying diagnosis: **Sheldon has no model of what a useful answer looks like.** It gathers, clusters by embedding similarity, writes one section per cluster — there's no point in the pipeline where it asks "is this what a smart person would want to read for this question?"

The stages here close that gap, in order of leverage and risk.

## Stage index

- [S1 — relevance gate, research contract, source classification](./S1-relevance-and-contract.md) *(shipped 2026-05-10, archive `2026-05-10-synthesis-quality-stage-1`)*
- [S2 — thesis-driven synthesis + triangulation + brutal editor](./S2-thesis-driven-synthesis.md) *(shipped 2026-05-10, archive `2026-05-10-thesis-driven-synthesis`)*
- [S3 — gap analysis, source-weighted scoring, proposer fix](./S3-research-quality.md) *(shipped 2026-05-10, archive `2026-05-10-research-quality`)*
- [v2 follow-ups](./v2-tuning-followups.md) *(shipped 2026-05-11, archive `2026-05-11-v2-tuning`)*
- [S4 — living hypothesis across iterations](./S4-living-hypothesis.md) *(deferred — re-evaluate after first real-task usage with S1+S2+S3)*

## Conventions for stage docs

Each stage doc has these sections (matching `docs/layers/` shape, with one addition):

- **Status** — planned / in-progress / shipped, plus blocking dependencies.
- **Why this stage exists** — concrete failure modes from reports A / B that this stage addresses, with section-level evidence so the motivation isn't abstract.
- **Goal** — one paragraph.
- **Hypotheses included** — `H1`–`H12` references back to the original handoff/follow-up vocabulary, so a future reader can match back to that conversation if needed.
- **Capabilities** — `New` and `Modified`, kebab-case names matching `openspec/specs/<name>/`.
- **Dependencies** — earlier stages or layers that must already exist.
- **Key data structures / decisions** — sketches; firmed up in openspec design.md when promoted.
- **Deletion lens** — *where in this stage does weak content get dropped?* If the answer is "nowhere," the stage is additive-only and probably won't move quality as much as expected. Every stage answers this section explicitly.
- **Out of scope** — what's deferred to later stages.
- **Open questions** — known unknowns to revisit at openspec design time.
- **Suggested openspec change name** — kebab-case.

## Cross-cutting principles

These hold across all four stages:

- **Deletion is a first-class operation.** v1 is purely additive — every fact extracted is stored, every cluster becomes a section. A real analyst's most important act is cutting. Each stage must add at least one explicit deletion point or flag why it can't.
- **Local model assumed: Qwen3.5-9B at 32k context, llama.cpp.** `llm.deep` is currently broken (thinking mode burns the output budget on `reasoning_content`). Use `llm.fast` for every new call until that's fixed at the model layer.
- **Existing patterns are not optional.** New LLM calls use `response_format: json_schema` + retry-once + markdown-fence stripping (see `extract.ts`/`propose.ts`/`decompose.ts`). New events extend the closed `EventKind` union in `events.ts`. New tables go in `db.ts` with `CREATE TABLE IF NOT EXISTS`. New thresholds are per-file constants, not config — match the convention.
- **Hardcoded thresholds need empirical tuning.** Anything called out as "start at X" in a stage doc is a guess that will need to be revised against telemetry from the first real run on the same outsourcing question.

## The success bar (unchanged across stages)

Stages are evaluated by whether a fresh report on *"What are the pain points of outsourcing companies in AI age?"*, run under similar deadline, beats reports A and B on:

- Has a real thesis stated up front (not a section list paraphrased into intro/outro).
- Surfaces at least 3 angles both A and B missed: pricing-model collapse, GCC/captive competition, cannibalization, named players (TCS/Infosys/Accenture/Cognizant/Wipro/Genpact), wage-arbitrage erosion.
- Section headings describe the argument, not the input cluster.
- Section content matches the heading.
- No off-topic sections (Google Cloud monitoring docs, generic latency alerting, generic AI privacy commentary).
- Cuts transitional padding ("Furthermore… Consequently… Ultimately…").
- Ranks and weighs — tells the reader what matters most and what's overhyped.

Each stage moves some subset of these. S1 is expected to fix the off-topic / heading / padding axes; S2 introduces the thesis and ranking; S3 unblocks the missing-angles axis. S4 is for the rare cases where multi-iteration belief revision matters.
