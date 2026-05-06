# Tasks

## 1. Event log writer

- [x] 1.1 Create `src/events.ts` exporting `EventKind` union (`'llm.fast' | 'llm.deep'`), `Event` type, and `events.emit(partial)` helper
- [x] 1.2 Implement append using `appendFile` from `node:fs/promises` to `.sheldon/events.jsonl`; create directory on first write
- [x] 1.3 Add `ts` (`new Date().toISOString()`) and ensure each line ends with `\n`
- [x] 1.4 Wrap the write in try/catch; on failure, `console.error` and return (do not throw)

## 2. Instrument LlmClient

- [x] 2.1 In `src/llm.ts`, after the dispatch resolves successfully, emit `llm.fast` or `llm.deep` with token usage and prompt preview
- [x] 2.2 In the non-2xx error path and on fetch failure, emit an event with `payload.error` before throwing
- [x] 2.3 Type-checker confirms `kind` matches the closed union

## 3. Watch CLI

- [x] 3.1 Create `src/watch.ts`; print existing log on start, then poll for appends
- [x] 3.2 200ms polling loop on `Bun.file(path).size`; read new bytes via `fs.read` at the prior offset
- [x] 3.3 Formatter: HH:MM:SS time, KIND uppercased and colored by family, `[layer]`, `(durationMs)`, payload one-liner
- [x] 3.4 Parse `--kind` (comma-separated, trailing `*` glob), `--layer` (comma-separated exact), `--since` (`30s`/`5m`/`1h`)
- [x] 3.5 Skip lines that fail JSON.parse without crashing
- [x] 3.6 Wire `bun run watch` script in `package.json`

## 4. Smoke test

- [x] 4.1 `bun run hello` produces 2 lines in `.sheldon/events.jsonl` (one fast, one deep)
- [x] 4.2 Each event has `ts`, `kind`, `layer:'L0'`, `durationMs`, payload with token counts
- [x] 4.3 `bun run watch` renders both events with color and timing
- [x] 4.4 `bun run watch --kind llm.fast` renders only the fast event; `--since 1ms` renders neither

## 5. Validate, document, archive

- [x] 5.1 `bun run typecheck` returns 0 errors
- [x] 5.2 `openspec validate add-event-log` passes
- [ ] 5.3 Update `README.md` Status line and layer index (L1 done)
- [ ] 5.4 Update `AGENTS.md` layer-status table (L1 done)
- [ ] 5.5 Run `openspec archive add-event-log --yes`
- [ ] 5.6 Verify `openspec/specs/event-log/spec.md` and `event-tail/spec.md` exist; verify `llm-client/spec.md` includes the new "emit one event per call" requirement
