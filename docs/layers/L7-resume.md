# L7 — Resume + crash recovery

## Goal

If the agent dies mid-run (laptop sleeps, process crashes, llama.cpp hiccups, whatever), the user runs `bun run resume` and the agent picks up exactly where it left off — same deadline, same frontier, same fact store, same phase. No work lost, no double-billing of time.

If we've designed L3–L5 correctly, this layer is mostly free; SQLite is already the source of truth for state. L7 is mainly about the entrypoint that recognizes a partial run and offers to resume it.

## Capabilities introduced

- `resume` — CLI subcommand that reads `run_state` from SQLite, validates the deadline hasn't expired, restores phase machine, and re-enters the main loop
- Crash-safety review of L3–L5 — every write is committed, no in-memory-only state that matters

## Dependencies

- All earlier layers, since this validates their persistence assumptions

## Key data structures / decisions

**Detection logic:**
- On startup, `bun run agent <task>` checks for an existing `.sheldon/sheldon.db` with `run_state.id=1` and `phase != 'done'`.
- If found: prompt user "There's an unfinished run from <time> ago, deadline <time>. Resume? [y/n/start-fresh]"
- `--resume` flag skips the prompt.
- `--fresh` flag wipes `.sheldon/` first.

**What's already crash-safe (must verify):**
- `frontier`: every push and status-update is a SQLite commit.
- `facts`: same.
- `run_state`: written at start, updated on phase transition.
- `events.jsonl`: append-only, no transaction needed; if the process dies mid-write we lose at most one line.

**What's NOT crash-safe (must fix in L7 if found):**
- In-flight scrapes: if we crash while fetching a URL, we lose the work. **Acceptable** — re-pop the same frontier question on resume, retry.
- In-flight LLM calls: same. Acceptable.
- Embedder warm-up state: just re-warm on resume, costs ~1s.

**Edge case: deadline already passed.**
On resume, if `Date.now() > deadline_at`, jump straight to synthesis (skip search/scrape entirely). User probably wants the report from whatever was gathered.

**Edge case: clock skew between runs.** If the user's machine clock changes between sessions, the agent might think more time elapsed than really did. Live with it — synthesis triggers on clock comparison, not elapsed counter.

## Out of scope

- Multi-machine resume (running on a different computer) — single-machine only; portable but not built for it
- Cloud sync of `.sheldon/` — user's responsibility
- Time-travel / branching ("what if I'd had more time") — interesting but out of scope

## Open questions

- Should resume offer to *extend* the deadline? Probably not by default — that defeats the discipline. Maybe a `--extend 1h` flag if user explicitly asks.
- How do we test crash recovery? Probably a `--kill-after Ns` debug flag that exits hard, plus manual ⌘C testing.
