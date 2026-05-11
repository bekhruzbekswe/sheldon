# Sheldon Architecture

> The bird's-eye view of the system. For per-file mapping see [`CODEBASE_MAP.md`](./CODEBASE_MAP.md). For per-capability requirements see [`openspec/specs/`](../openspec/specs/). For the audit trail of how we got here see [`openspec/changes/archive/`](../openspec/changes/archive/).

Sheldon is a deadline-bounded autonomous research agent. The user provides a question and a wall-clock deadline; the agent gathers evidence across timed phases, then writes a cited Markdown report. All canonical state lives in SQLite (`bun:sqlite`). All observable state lives in an append-only JSONL event log. A separate Hono process serves a localhost dashboard that streams events via SSE.

The system is layered (L0–L8) and additive — each layer introduces one capability the next stands on, and every layer narrates itself through L1's event log. After v1 shipped, four corrective initiatives (S1–S3 + v2-tuning) sharpened synthesis quality without breaking the layered shape.

---

## L0–L8 — Layered architecture

Each layer's "Capabilities" maps 1:1 to a directory under `openspec/specs/`.

### L0 — LLM client

`llm-client` is the lowest layer. Wraps a locally-served Qwen3.5-9B (via llama.cpp) at 32k context. Two modes: `llm.fast` (no thinking) and `llm.deep` (thinking on). **`llm.deep` is currently broken** at this model/prompt shape — thinking consumes the entire output budget on `reasoning_content` and returns 0 tokens of content. Every v1 and v2 LLM call uses `llm.fast`. If `llm.deep` is ever needed, the cleanest path is SSE-streamed responses (keeps the upstream connection alive past Cloudflare's 100s edge timeout); see L6 "What actually shipped" history.

Every LLM call emits a `llm.fast` / `llm.deep` event into L1's log with token counts and latency.

### L1 — Event log (visibility primitive)

Built **before** any agentic logic so every later layer is observable from the first commit. Two capabilities:

- `event-log` — append-only `.sheldon/events.jsonl`. Each line is `{ts, kind, layer, durationMs?, payload}`. `kind` is a closed TypeScript union enforced at compile time (`src/events.ts`).
- `event-tail` — `bun run watch` follows the file with color-coded, single-line output. Supports `--kind`, `--since`, `--layer` filters.

**Canonicity:** SQLite is canonical for state; events narrate. If the log is corrupted/deleted mid-run the agent keeps going.

### L2 — Search loop

The simplest possible "answer one question with web help" pipeline, wired end-to-end before any structure goes on top.

- `searxng-client` — POST/GET against a SearXNG instance (sibling docker-compose, port 8888). Returns `{title, url, snippet, score}[]`.
- `web-scraper` — `@mozilla/readability` + `jsdom` strips nav/ads/footers and returns cleaned plaintext.
- `search-loop` — ties the LLM client + searxng + scraper into one iteration: take a question → 1 search → top 3 results → scrape → summarize.

### L3 — Fact store

Introduces structured, persistent memory. After this layer, the agent stops being "summarize what you read" and becomes "build a knowledge base."

- `chunker` — token-aware ~400-token chunks with ~80-token overlap, paragraph-aware splitting.
- `embedder` — `@xenova/transformers` with `all-MiniLM-L6-v2` (384-dim).
- `fact-store` — SQLite table `facts(id, claim, source_url, source_title, raw_excerpt, embedding BLOB, topic_tag, confidence, question_id, created_at)`. Brute-force cosine in JS for similarity search; swap to `sqlite-vec` if we ever exceed ~10k facts.
- `claim-extractor` — `llm.fast` with strict `response_format: json_schema`. Returns atomic claims with `confidence ∈ [0,1]` and a freeform `topic_tag`.

### L4 — Frontier queue

Makes the agent self-directed. It now maintains a queue of questions, pops the highest-scored, runs L2's pipeline, extracts L3's claims, and asks the LLM to propose 3–5 follow-ups based on what it just learned.

- `frontier-queue` — SQLite table `frontier(id, question, score, status, parent_id, depth, embedding, …)`. Priority pop by `score DESC` among `status='pending'`.
- `question-decomposer` — emits 10–20 seed questions from the original task.
- `followup-proposer` — emits 3–5 follow-ups per iteration with `{question, score, why}`.
- `scorer` — combines novelty (embedding distance from done), relevance (LLM scalar), and depth decay (`score × 0.9^depth`).

Novelty filter dedupes new proposals against existing frontier by cosine > 0.85 (logged as `frontier.dedupe`).

### L5 — Time budget + phase machine

Replaces L4's "30 iterations" with a real wall-clock deadline and three phases that change the agent's behavior as the clock ticks.

- `phase-machine` — derives current phase from `Date.now()` against `deadline_at`. Correct after crash + resume mid-phase.
- Phase boundaries (defaults): `breadth` 0–30%, `depth` 30–80%, `synthesis` 80–100%. For a 5-hour run: 1.5h breadth, 2.5h depth, 1h synthesis.
- Phase-aware scoring: breadth biases toward novelty + penalizes depth aggressively; depth inverts and rewards going deep on promising threads.
- `run_state` — singleton SQLite row that L7 reads on resume: `{task, started_at, deadline_at, phase, contract_json, task_embedding}`.

### L6 — Synthesis

When the synthesis phase fires, produce a written report. This layer is where most of the perceived quality of Sheldon comes from.

Three capabilities ship in v1:

- `cluster-facts` — k-means with silhouette analysis (k ∈ 5–10) over fact embeddings. Drops tiny clusters (<5 facts).
- `section-writer` — `llm.fast` writes one ~300-word section per cluster with `[N]` citations local to that section.
- `report-stitcher` — programmatic concatenation; re-numbers `[N]` to global numbering; emits intro + sections + conclusion + bibliography.

**v2 replaces clusters as the default path.** See the [v2 synthesis pipeline](#v2-synthesis-pipeline) section. Clustering remains as the `synthesis.fallback` path when the thesis returns no usable claims.

### L7 — Resume + crash recovery

If the agent dies mid-run, `bun run resume` reads `run_state` and continues with the same deadline, frontier, fact store, and phase. The earlier layers were designed crash-safe so this layer is mostly an entrypoint.

Edge cases:
- Deadline already passed on resume → skip search/scrape, jump straight to synthesis.
- Clock skew between sessions → live with it; phase is wall-clock-derived, not elapsed-counter.

### L8 — Live dashboard

Read-only Hono server on `127.0.0.1:4000`. Two capabilities:

- `dashboard-server` — REST snapshots (`/api/run-state`, `/api/frontier`, `/api/facts`, `/api/stats`, `/api/contract`, `/api/synthesis-state`, `/api/report`) + SSE feed (`/api/events`) tailing `events.jsonl`.
- `dashboard-ui` — single self-contained `web/index.html`. Vanilla JS, no framework, no bundler.

The dashboard runs in a separate process from the agent (same machine, SQLite is the bridge). No mutation endpoints — non-GET is 405.

---

## v2 synthesis pipeline

After v1 shipped, two reports on the same question were evaluated against the bar of "what a smart, opinionated analyst would write." Both fell short:

- **Report A** — 19.4 min, 10 iterations, 266 facts, 10 sections.
- **Report B** — 35.4 min, 18 iterations, 697 facts, 8 sections.

Symptoms — off-topic sections, slug headings, transitional padding, single-source over-reliance, vendor marketing weighted equally with rigorous sources, no thesis — traced back to a unifying diagnosis: **Sheldon had no model of what a useful answer looks like.** It gathered, clustered by embedding similarity, wrote one section per cluster — nowhere in the pipeline did it ask "is this what a smart person would want to read for this question?"

Four corrective initiatives closed that gap. After v2, synthesis uses a thesis-driven path with cluster as fallback:

```
breadth/depth gathering
   │
   ▼
┌────────────────────────────────────────────────────┐
│ synthesis.start                                    │
│   ↓                                                │
│ thesis-drafter                                     │
│   • samples task-relevant, source-diverse evidence │
│   • emits 4–7 load-bearing claims                  │
│   ↓                                                │
│   (no usable claims?) ──► synthesis.fallback ──► cluster path
│   ↓                                                │
│ claim-triangulator (per claim, 3 min budget each)  │
│   • targeted corroborate / contradict searches     │
│   • marks each claim contested? + counts           │
│   ↓                                                │
│ section-writer (one per claim)                     │
│   • drafts section defending its claim             │
│   ↓                                                │
│ section-rubric                                     │
│   • each section checked against rubric            │
│   • failures get one revision attempt then drop    │
│   ↓                                                │
│ report-stitcher                                    │
│   • renumber citations, render intro + conclusion  │
│   • write .sheldon/reports/<run-id>.md             │
└────────────────────────────────────────────────────┘
```

Cross-cutting v2 mechanisms:

- **Research contract** (S1) — at run start, the agent commits to a JSON contract of `{core_question, sub_questions, good_answer_contains, out_of_scope}` stored on `run_state`. Every later step references it (relevance scoring, gap analysis, thesis drafting, rubric evaluation).
- **Source classifier** (S1) — every domain seen during scrape is classified into a tier (rigorous / mixed / marketing / aggregator). Score-weighted at scoring and triangulation; gates out the loudest noise.
- **Gap analyzer** (S3) — at phase boundaries, the agent diffs the current corpus against the contract's `good_answer_contains` and feeds named gaps (specific players, specific angles) back to the proposer. Logged as `gap.analyzed` with diagnostics.
- **Deletion as first-class operation** — v1 was purely additive (every fact stored, every cluster a section). v2 introduces drop points: `fact.dropped.irrelevant` at extraction, contested-claim flags at triangulation, `section.dropped` at the rubric, banned-closer post-processor at stitch. A real analyst's most important act is cutting.

For the as-built artifacts of each initiative, see `openspec/changes/archive/2026-05-10-synthesis-quality-stage-1/`, `2026-05-10-thesis-driven-synthesis/`, `2026-05-10-research-quality/`, `2026-05-11-v2-tuning/`, `2026-05-12-v2-dashboard-refresh/`.

---

## Cross-cutting invariants

These hold across every layer and every initiative. New work that violates them is suspect.

- **Closed event union.** Every event kind lives in the `EventKind` union in `src/events.ts`. Adding a kind = TypeScript compile error until every consumer handles it.
- **Structured-output pattern.** Every LLM call that returns JSON uses `response_format: json_schema` + retry-once-on-parse-failure + markdown-fence stripping. Pattern lives in `src/extract.ts`, `propose.ts`, `decompose.ts`, `contract.ts`, etc.
- **`llm.fast` everywhere.** `llm.deep` is broken at the model layer; do not use it. If quality requires deep mode, fix at L0 first.
- **SQLite canonical, log narrates.** Crash safety derives from SQLite commit boundaries. The log is for humans; it may have gaps after a crash.
- **Per-file constants for thresholds.** No config files for numeric tuning. Each module owns its own constants (e.g. `PER_CLAIM_BUDGET_MS = 180_000` in `triangulate.ts`). Easy to grep, easy to tune.
- **Phase-boundary hooks.** Anything that needs to run on `breadth → depth` or `depth → synthesis` registers in the phase machine and is walked for every transition crossed (covers the case where a single iteration spans multiple boundaries).
- **`bun run typecheck` and `openspec validate` are pre-commit gates.** Neither has external lint dependencies; both are fast.

---

## Storage shape

**`.sheldon/events.jsonl`** — append-only narration. One JSON object per line. Truncate freely between runs; nothing reads it for canonical state.

**`.sheldon/sheldon.db`** (SQLite via `bun:sqlite`):

- `run_state` (singleton) — `{task, started_at, deadline_at, ended_at, phase, contract_json, task_embedding}`. L7 reads on resume.
- `facts` — append-only knowledge base. Vector similarity by brute-force cosine in JS.
- `frontier` — the queue. Status lifecycle `pending → in-progress → done | skipped`.
- `sources` — keyed by domain. Holds the source classifier's tier + score. Persists across `--fresh` runs to avoid re-classifying known domains.

**`.sheldon/reports/<started_at>.md`** — one report per run, plus `latest.md` for the most recent. The dashboard's `/api/report` resolves the current run's report first, falls back to `latest.md`.
