## Context

L0 shipped a working LLM client with no observability. Higher layers (search, scrape, fact extraction, frontier) need every action traceable in real time. We're a single-process node-style runtime (Bun), so the simplest reliable telemetry is an append-only JSONL file plus a separate tail command for human consumption.

The shape of an event is load-bearing — every layer above this one will write events, so getting the kind taxonomy and required fields right matters more than the writer being clever.

## Goals / Non-Goals

**Goals**

- Single-process append-only writer with no external dependencies
- TypeScript-enforced kind taxonomy (compile error on unknown kinds)
- Human-readable colored tail with kind/layer/since filters
- Non-throwing emit (telemetry must never kill the agent)
- Instrument the L0 LlmClient to set the pattern for L2+

**Non-goals**

- Log rotation (file will grow ~2 MB for a 5-hour run; deferred to L7/L8 if it becomes a problem)
- Cross-process locking (Sheldon is single-process; the watch command is a read-only follower)
- Structured ingestion / SQLite indexing of events (the events log is for humans; persistent state lives in SQLite tables added by L3+)
- Sampling / verbosity levels (every action emits; filtering is a read-side concern)
- OpenTelemetry / standardized tracing (overkill for one local agent)

## Decisions

### Decision 1: JSONL on disk, not in-memory ring buffer

**Why**: A 5-hour run is too long to hold in memory if the user wants to scroll back. A file persists across watch process restarts, can be re-tailed at any time, and is trivially `grep`-able after the run is over.

**Alternatives considered**:
- *In-memory ring buffer + SSE* — fine for L8 dashboard, but requires the agent process to be alive to read history.
- *SQLite for events* — schema rigidity is a cost we shouldn't pay yet; JSONL is more permissive while we discover what fields we need.

### Decision 2: `Bun.write` with append flag, no explicit fd management

**Why**: Bun's `Bun.write(path, content, { append: true })` API is well-tested, async, and atomic enough for our single-process append pattern. No need to keep an open file handle around. Each emit is one round-trip; we'd worry about fsync only if we expected crashes mid-write, which is acceptable data loss for telemetry.

### Decision 3: Closed string-literal union for kinds

**Why**: A `type EventKind = 'llm.fast' | 'llm.deep'` enforced at the call site makes typos compile errors. As layers ship, each adds its kinds to the union. This trades a small refactor cost (touching the union when adding a new layer) for big payoff in catching `'lm.fast'` typos before they ship.

**Alternatives considered**:
- *Loose `string` for kind* — easy but invites drift; we'd discover misnamed kinds only when the watch filters mysteriously fail.
- *Enum* — heavier ergonomics in TS strict mode, no real win over union.

### Decision 4: `watch` follows the file via polling, not native fs.watch

**Why**: Cross-platform fs.watch is unreliable (especially on macOS for append-only files). A 200ms polling loop on `Bun.file().stat()` is robust, dead simple, and the latency is imperceptible for human consumption. Bun's `Bun.file(path).stream()` does follow appends but is less battle-tested than the polling approach.

### Decision 5: `events.emit` is fire-and-forget (non-blocking, non-throwing)

**Why**: The agent's main loop must keep going even if the disk is full or the file is locked. We log the failure to stderr and return. If telemetry is essential, the user will notice missing lines in `watch` and act.

**Alternatives considered**:
- *Throw on failure* — couples agent reliability to disk health, which we don't want.
- *Buffer + retry* — adds complexity; the right move if we ever batch-write, but premature now.

### Decision 6: Each emit is its own write (no batching)

**Why**: Throughput is not a concern (~1000 events/hour). Per-event writes mean live tailing sees events the moment they're emitted, which is the whole point.

## Risks / Trade-offs

- **[Risk] File grows unboundedly for long runs.** → For a 5-hour run we estimate ~10k events × ~250 bytes ≈ 2.5 MB. Acceptable. L7/L8 can introduce rotation if it becomes a real problem.
- **[Risk] If two processes write to the file simultaneously, lines could interleave.** → Sheldon is single-process by design. The watch command is read-only. Won't happen in practice.
- **[Risk] On unclean shutdown, the last emit may be partially written and break JSONL parsing.** → Per-event writes are small; the OS-level append is generally line-atomic for sub-PIPE_BUF sizes (≤4KB on macOS). For paranoia, the watch parser will skip lines that don't parse.
- **[Trade-off] Polling tail (200ms) has up-to-200ms latency.** → Imperceptible for humans reading a single colored line per event.

## Migration Plan

L0 → L1 is additive. The LlmClient gains an `events.emit` call; existing API surface is unchanged. No data migration. Existing `bun run hello` continues to work and now produces 2 events per run.

## Open Questions

- Should the watch CLI accept multiple `--kind llm.*,search.*` patterns or only one? **Decided**: comma-separated, treated as OR. Resolved during spec authoring.
- Where is the event log written if the agent runs from a system path with no CWD? **Tentative**: error out at first emit; we'll cross this bridge if it ever happens.
- Should events include a process-id / run-id? **Deferred to L5/L7** when multi-run state is real.
