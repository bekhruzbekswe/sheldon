# L4 — Frontier queue

## Goal

Make the agent self-directed. Instead of answering one question, it now maintains a queue of questions, pops the highest-scored, runs L2's pipeline, extracts L3's claims, and **asks the LLM to propose 3–5 follow-up questions** based on what it just learned. Those proposals get scored and pushed back on the queue. The loop runs for a fixed number of iterations (clock comes in L5).

This is the layer where the agent earns the "research" name — it's now exploring, not just answering.

## Capabilities introduced

- `frontier-queue` — SQLite-backed table of `{id, question, score, status, parent_id, depth, embedding, created_at, processed_at}` with priority-pop, mark-done, and similarity-dedupe operations
- `question-decomposer` — LLM prompt that takes the user's original task and emits N seed questions
- `followup-proposer` — LLM prompt that takes (current question, claims-just-found, remaining frontier summary) and emits N follow-up questions with scores
- `scorer` — combines novelty (embedding distance from done questions), relevance (LLM scalar 0..1), and depth-decay (score ← score × 0.9^depth) into a single priority

## Dependencies

- L0 / `llm-client`
- L1 / `event-log`
- L2 / `search-loop`
- L3 / `fact-store`, `embedder`

## Key data structures / decisions

**Schema (draft):**
```sql
CREATE TABLE frontier (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question TEXT NOT NULL,
  score REAL NOT NULL,
  status TEXT NOT NULL,         -- 'pending' | 'in-progress' | 'done' | 'skipped'
  parent_id INTEGER,            -- which question spawned this; null for seeds
  depth INTEGER NOT NULL,       -- 0 for seeds, depth+1 for children
  embedding BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  processed_at INTEGER
);
CREATE INDEX idx_frontier_status_score ON frontier(status, score DESC);
```

**Pop strategy:** `SELECT * FROM frontier WHERE status='pending' ORDER BY score DESC LIMIT 1`. Mark in-progress before doing work; mark done at end (or skipped if it errored).

**Decomposer prompt (draft):**
- Mode: `llm.fast()`
- Input: user's original task
- Output: JSON array of 10–20 seed questions, each tagged with a rough topic and an initial score 0.5–0.9

**Followup-proposer prompt (draft):**
- Mode: `llm.fast()`
- Input: question just answered (1 line) + 5–10 most recent claims (paraphrased) + summary of frontier (top 5 pending questions, by title only)
- Output: JSON array of 3–5 follow-ups, each `{question, score, why}`. The `why` field is logged for debugging but unused by the scorer.

**Novelty filter:** before pushing a proposal, embed it and compare to all `done` and `pending` frontier questions. If cosine > 0.85 to any existing question, drop it (the agent is rediscovering territory). Logged as `frontier.dedupe`.

**Score formula:**
```
final_score = (0.5 * relevance) + (0.3 * novelty) + (0.2 * (0.9 ** depth))
```
Tunable. The depth decay prevents one thread from going arbitrarily deep at the cost of breadth.

**Iteration cap (L4 only):** stop after 30 iterations. L5 replaces this with a wall-clock deadline.

## Out of scope

- Wall-clock deadline (L5)
- Phase-aware behavior changes (breadth vs depth) (L5)
- Parallelism — strictly sequential pop→work→push for now
- Synthesis (L6)

## Open questions

- Score formula coefficients are guesses. Tune after watching a few runs in the L1 log.
- Do we ever revisit `done` questions? Probably no, but if a question dead-ends (zero claims extracted), maybe mark `skipped` and try a sibling rephrasing. Decide based on observed behavior.
- Should the proposer have access to the *full* frontier (titles only), or just the parent's siblings? Full is more contextual but uses more tokens. Start with top-5-pending.
