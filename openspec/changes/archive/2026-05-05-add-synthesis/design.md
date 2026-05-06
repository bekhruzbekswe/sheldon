## Context

Through L5 the agent gathers and stops. L6 is "deliver." The fact store has hundreds of atomic claims with embeddings; the user wants a 3-page report. The hard constraint we've built around since L0 is that no single 32k-context call can hold all the facts at once. Synthesis therefore must split-then-stitch:

```
all facts → cluster by embedding → write one section per cluster → stitch
```

Each section gets its own `llm.deep` call with the cluster's facts and an instruction to cite by local 1-based index. The stitcher then renumbers all local citations to a single global numbering and renders a Sources bibliography.

This is also the layer where we finally use `deep` mode at scale. The `fast`/`deep` toggle we added in L0 was specifically for this — synthesis is the rare call where we trade 30s for quality.

## Goals / Non-Goals

**Goals**

- Produce a finished `.sheldon/reports/<runId>.md` plus `latest.md` symlink (or just a fresh write — symlinks are tricky on some filesystems; a copy is fine).
- Cluster facts by embedding with k-means; pick k automatically; drop tiny clusters.
- Per-cluster section using `llm.deep` with citation discipline.
- Global citation renumbering that collapses duplicate URLs across sections.
- Wire automatically into the research loop's exit; also expose a standalone `bun run synthesize` for testing/recovery.

**Non-goals**

- HTML/PDF/Slides — Markdown only.
- Streaming the report mid-write — user is offline, full-file delivery is the model.
- Cross-section consistency passes ("does section 3 contradict section 5?") — out of scope; if it happens we'll add a polish pass later.
- Pushing the report somewhere (Telegram, Slack, email) — separate layer.
- Incremental synthesis as data accumulates — full-file regeneration each time.

## Decisions

### Decision 1: K-means over hierarchical clustering

**Why**: K-means is ~50 lines in TypeScript, deterministic given a seed, and produces evenly-sized clusters that map naturally to "one section per cluster." Hierarchical agglomerative clustering produces nicer trees but the tree is overkill — we just want N flat groupings.

**Alternatives considered**:
- Hierarchical agglomerative with a similarity threshold — gives variable cluster count "for free" but harder to tune.
- DBSCAN — handles noise well but tuning `eps` is fiddly.
- LLM-driven clustering ("here are 200 claims, group them into themes") — a single 200-claim prompt blows past 32k context; deferred.

### Decision 2: K is selected by silhouette score in [5, 10]

**Why**: We want 5–10 sections in a typical report; that range is the user-experience constraint, not a math constraint. Silhouette is the standard cluster-quality metric (high = clusters are well-separated). Iterating across [5, 10] is 6 evaluations × ~10ms each = trivial. We keep the k that scored highest.

### Decision 3: Drop tiny clusters rather than fold them in

**Why**: Tiny clusters are usually noise (one edge-case article, one off-topic page that snuck through). Folding them into a "Notes" appendix sounds nice but in practice the noisy facts pollute readable sections more than they help. Better to discard cleanly. We log how many facts were excluded so the user can sanity-check.

### Decision 4: Local 1-based citations per section, then renumber globally

**Why**: Two reasons:
1. **Token economy.** A local section with 30 facts cites them as `[1]..[30]`. Without local numbering we'd have to give the LLM *global* fact ids that might be 4-digit numbers, increasing token count.
2. **LLM reliability.** Models cite small consecutive numbers far more reliably than large or sparse ones. Local 1..N is the easy mode.

The stitcher then walks each section's body, extracts `[N]` references, looks up the corresponding `factIds[N-1]`, maps to a global number (collapsing duplicate URLs), and rewrites.

### Decision 5: Section-writer uses `llm.deep` (thinking on)

**Why**: This is the rare quality-critical call. Synthesis is what the user reads. Fast-mode synthesis would produce competent but flat prose. Deep mode produces noticeably better connective tissue, contradiction-noting, and prioritization. We'll do ≤10 deep calls per run; total time ≈ 2–6 min, fits inside the 20% synthesis budget.

### Decision 6: Intro and outro see only section *labels*, not bodies

**Why**: They're framing text — a paragraph or two. They don't need to repeat the bodies. Giving them only labels keeps their token budget tiny and guarantees they don't introduce facts that contradict the sections.

### Decision 7: Fact citations within a section can be filtered post-hoc

**Why**: Even with grammar-constrained output, a model can occasionally cite `[7]` when only 5 facts were provided. Rather than throw away the whole section, we strip the bad citation and continue. The bracket regex is `/\[(\d+)\]/g` over a whitelist `1..N`. This is post-processing; the stitcher then sees only valid local citations.

### Decision 8: Reports go to `.sheldon/reports/<runId>.md` plus `latest.md`

**Why**: A finished run gets its own immutable file (using `started_at` as run-id). `latest.md` is a copy (not a symlink — friendlier to some text editors and git diffs) updated on every synthesis. Past reports stay around for inspection. If the user re-runs synthesis on the same DB, we append a `-v2` suffix to avoid clobbering.

### Decision 9: Auto-trigger from research loop, but allow standalone

**Why**: The end-to-end product is "deadline expires → report exists." So `runResearch` calls `synthesize()` after exiting the loop in synthesis phase. But the standalone `bun run synthesize` command is essential for:
- Recovering from a crash mid-synthesis (re-run against the same DB).
- Re-synthesizing with a different prompt (rare but real use case).
- Testing the synthesis layer without spending an hour on research first.

### Decision 10: Sequential section writing (one at a time)

**Why**: Local llama.cpp is single-instance. Two parallel `llm.deep` calls would queue at the server, doubling each individual call's wall time, with no real parallelism gained. Sequential is simpler to debug and produces the same total wall time.

## Risks / Trade-offs

- **[Risk] Silhouette score on cosine-distance with 384-dim vectors can be noisy at small N.** → Mitigation: with <30 facts we just use k=1 (a single section); the run is too small to cluster meaningfully. Documented in cluster.ts.
- **[Risk] Bad LLM output (empty section, too short, no citations).** → Mitigation: re-call once with a stronger instruction; if still bad, omit that section from the report and log a `section.written` event with `error`. Doesn't fail the whole report.
- **[Risk] Citation renumbering bug produces dangling `[?]`.** → Mitigation: stitcher tests verify "every citation in the rendered body has an entry in the Sources list and vice versa." A property-test in design.md, not yet a formal test in code.
- **[Trade-off] Reports are static markdown; no in-line "read more" or expand-fact UX.** → Acceptable for L6. L8 dashboard could overlay interactive views.
- **[Risk] Parallel processes running synthesis on the same DB clobber each other's `latest.md`.** → Single-process by design; not a real risk.
- **[Risk] Run with 0 surviving clusters (every cluster < 5 facts).** → The synthesizer falls back to a single "Findings" section listing all facts. Better than no report.

## Migration Plan

Additive to the running agent. After this lands, every `bun run research --deadline X` produces a report at the end. Existing `bun run ask` is unchanged.

## Open Questions

- Do we keep `last-summary.md` (from L2) when running `research`? **Decided**: yes, the L2 ask path is independent and still useful for one-shot queries. Research writes to `reports/`, not `last-summary.md`.
- Should we re-cluster mid-run as facts accumulate? **Decided**: no, premature. Cluster once at synthesis start.
- What if the cluster labels are bad? **Decided**: live with it for v1; tune labeling prompt later.
- How should the report look on terminal `cat` vs in a Markdown viewer? **Decided**: pure standard Markdown. No ANSI codes. The user's editor renders it.
