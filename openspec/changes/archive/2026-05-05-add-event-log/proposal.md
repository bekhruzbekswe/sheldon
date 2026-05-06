## Why

Sheldon will run unattended for hours. The user explicitly named visibility the most important property: "I cannot just give the task and trust." Before any agentic logic ships, every action the system takes must be observable in real time — what was searched, what was scraped, what claim was extracted, why a question was popped from the frontier.

Building this primitive *before* the agentic layers means each higher layer is born observable. Bolting it on later means rewriting every action site to log itself, which is exactly when the agent is most opaque (mid-build).

## What Changes

- New event-log module that appends structured events as JSON lines to a file under `.sheldon/events.jsonl`
- Single-process append-only writer — no locking, no rotation in this layer
- Typed kind taxonomy enforced in TypeScript (`'llm.fast' | 'llm.deep' | …`) so misnamed events fail at compile time
- New CLI command `bun run watch` that tails the log and renders one colored single-line per event with optional filters (`--kind`, `--since`, `--layer`)
- Instrument the existing `LlmClient` (from L0) to emit `llm.fast` and `llm.deep` events with usage and latency on every call

Out of scope: log rotation, structured-event SQL ingestion, web dashboard (those are L8 if needed).

## Capabilities

### New Capabilities

- `event-log`: append-only JSONL event sink with a typed kind taxonomy. Every event carries `ts`, `kind`, `layer`, `payload`, optional `durationMs`. File location auto-created at `.sheldon/events.jsonl` relative to CWD.
- `event-tail`: terminal CLI that follows the JSONL file in real time, renders one colored line per event, supports kind/layer/since filters.

### Modified Capabilities

- `llm-client`: gains a non-functional requirement to emit one event per call. Output shape unchanged.

## Impact

- Code: creates `src/events.ts`, `src/watch.ts`. Modifies `src/llm.ts`.
- Dependencies: none (Bun's built-in file APIs cover append + tail).
- External: `.sheldon/` directory created on first event write. Add to `.gitignore` if not already.
