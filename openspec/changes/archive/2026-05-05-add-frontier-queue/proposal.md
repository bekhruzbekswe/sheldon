## Why

L0–L3 give us "ask one question, get an answer with facts indexed." That's a Q&A tool. Sheldon's actual purpose is **autonomous research over hours**, where the agent decides what to investigate next based on what it just learned. L4 is the layer where it earns the "research" name.

The mechanism: a SQLite-backed **frontier queue** of questions, each scored. Pop highest-scored, run the existing search-loop on it, extract claims, then ask the LLM to **propose 3–5 follow-up questions** based on what it found. Novelty-dedupe the proposals against questions already in the queue (so the agent doesn't keep rediscovering the same thread), score them, push back. Repeat until iteration cap.

L4 doesn't have a wall-clock deadline yet — that's L5. L4 stops after a fixed number of iterations.

## What Changes

- New `frontier-queue` SQLite table tracking `{question, score, status, parent_id, depth, embedding}`
- New `question-decomposer` module that turns a user task into 10–20 seed questions
- New `followup-proposer` module that turns "question just answered + recent claims" into 3–5 scored proposals
- New `scorer` module: combines LLM-given relevance, embedding-based novelty, and depth-decay into one priority score
- New main loop `runResearch(task, opts)` that ties it all together
- New `bun run research "<task>" [--max-iters N] [--seeds M]` CLI
- New event kinds: `frontier.seed`, `frontier.push`, `frontier.dedupe`, `frontier.pop`, `frontier.done`, `frontier.skip`, `iteration.start`, `iteration.end`
- Refactor the indexing path so it accepts a `questionId` so claims can be linked back to the frontier entry that spawned them (the `facts.question_id` column from L3 finally gets populated)

Out of scope: wall-clock deadlines (L5), phase-aware behavior shifts breadth↔depth (L5), parallelism, synthesis/report (L6).

## Capabilities

### New Capabilities

- `frontier-queue`: SQLite-backed priority queue with novelty-aware push (cosine ≥ 0.85 against existing entries skips) and pop-highest-scored.
- `question-decomposer`: LLM prompt converting a user research task into 10–20 seed sub-questions, each with a topic tag and an initial score in [0.5, 0.9]. Uses `llm.fast` with JSON-schema output.
- `followup-proposer`: LLM prompt that takes (current question, recent claims, top-pending frontier titles) and emits 3–5 follow-ups with relevance scores in [0, 1] and a debug `why`. Uses `llm.fast` with JSON-schema output.
- `scorer`: pure function combining relevance (from LLM), novelty (1 − max cosine to nearest existing frontier entry), and depth decay (`0.9 ^ depth`) into one final score.

### Modified Capabilities

- `event-log`: extend `EventKind` union with `'frontier.seed' | 'frontier.push' | 'frontier.dedupe' | 'frontier.pop' | 'frontier.done' | 'frontier.skip' | 'iteration.start' | 'iteration.end'`.
- `fact-store`: `factStore.insert` already accepts `questionId`; L4 now passes it through so claims are linked to the frontier entry.

## Impact

- Code: new `src/frontier.ts`, `src/decompose.ts`, `src/propose.ts`, `src/score.ts`, `src/research.ts`, `src/run.ts`. Modifies `src/events.ts`, `src/loop.ts` (extract `indexSource` so it accepts `questionId`), `src/db.ts` (add `frontier` table to the idempotent CREATE block), `package.json` (new `bun run research` script).
- Dependencies: none (everything we need is already installed).
- Storage: same SQLite file gains a `frontier` table.
- Performance: each iteration adds one `decompose` (only at start) or `propose` LLM call on top of L3's existing per-source extractions. For a 5-iteration smoke test, this is negligible overhead.
