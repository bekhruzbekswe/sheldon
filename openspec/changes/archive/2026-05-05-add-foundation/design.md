## Context

L0 establishes the project root and the LLM access primitive. Every later layer (event log, search, fact store, frontier, synthesis) calls into the LLM client, so getting its shape right matters. We've already verified the server-side contract:

- Endpoint: `https://ai.mayoq.tech/v1/chat/completions` (OpenAI-compatible)
- Model: `Qwen_Qwen3.5-9B-Q4_K_M.gguf`
- Context: 32k tokens
- Auth: bearer token
- **Critical: requires `User-Agent: Mozilla/5.0`** — Cloudflare blocks the OpenAI SDK's default UA (verified with 403 reproductions and direct curl tests)
- Thinking toggle: `chat_template_kwargs: { enable_thinking: true|false }` (verified — fast mode is ~20× faster and produces empty `reasoning_content`)

## Goals / Non-Goals

**Goals**

- Single, narrow LlmClient module with two methods (`fast`, `deep`)
- Plain `fetch`, no SDK — we control the User-Agent
- Environment-driven config; throws fast on missing env vars
- Smoke test (`bun run hello`) that exercises both modes and prints timings/tokens
- TypeScript strict mode

**Non-goals**

- Streaming (added in a later layer when the UI/CLI needs it)
- Structured output / JSON-schema response_format (added in L3 when claim extraction lands)
- Embeddings (handled by `@xenova/transformers` in a later layer, separate module)
- Retry/backoff (deferred — first wire-up should fail loud)
- Multiple providers (we want one LLM, not an abstraction over many)

## Decisions

### Decision 1: Plain `fetch`, not the OpenAI SDK

**Why**: We hit a hard 403 in prior work because Cloudflare in front of `ai.mayoq.tech` blocks the OpenAI SDK's `User-Agent: OpenAI/JS x.y.z`. The SDK's `defaultHeaders` *should* override but didn't reliably (Turbopack caching also burned us). Bypassing the SDK eliminates an entire class of "why isn't my header sticking" bugs.

**Alternatives considered**:

- *Use the OpenAI SDK with `defaultHeaders`* — proven brittle in this stack.
- *Run a local proxy that rewrites the UA* — extra moving part, more failure surface.

### Decision 2: Two named methods (`fast`, `deep`) instead of `chat({ thinking })`

**Why**: Clearer call sites. Reading code, you see `llm.fast(...)` for high-frequency calls and `llm.deep(...)` for synthesis — the intent is on the page. A boolean parameter would invert that ("which mode again?" requires looking up the call). Also harder to grep for misuse.

### Decision 3: Environment-driven config, throw on missing

**Why**: Failing at construction is much better than failing on the first network call somewhere deep in a 4-hour run. Fast feedback when the user runs `bun run hello` for the first time.

### Decision 4: Bun runtime, TypeScript strict

**Why**: Bun gives us native `fetch`, native `.env`, fast startup, native TS — no `tsx`, `ts-node`, `vitest`, `dotenv` packages needed. Smaller dependency surface for a project that will ship to one machine.

**Alternatives considered**: `node + tsx` (requires more deps), `deno` (less ecosystem familiarity for the user's stack).

### Decision 5: No retry/backoff in L0

**Why**: We want to surface real failures loudly during early development. Adding retry now would mask the very integration issues (UA blocks, auth, timeouts) we need to see while wiring things up. Retry belongs to a later resilience layer once we know the failure modes.

### Decision 6: Return shape includes `usage` and `latencyMs`

**Why**: Later layers will use these for budget enforcement (we can't blow past hourly token quotas) and for the visibility log (every action carries timing). Including them now is free; adding later is a breaking change.

## Risks / Trade-offs

- **[Risk] llama.cpp may change its `chat_template_kwargs` shape with future versions.** → Mitigation: keep the request body construction in one place (`LlmClient.dispatch`), so adapting is a one-line change.
- **[Risk] Hardcoded `Mozilla/5.0` UA may itself be filtered if Cloudflare tightens rules.** → Mitigation: UA is a constant, easy to update; we can also expose it as an env override later if needed.
- **[Risk] No retry means transient network blips kill the smoke test.** → Mitigation: acceptable for L0. L1 or L2 will introduce per-call retry.
- **[Trade-off] Plain fetch means we hand-roll OpenAI request shape.** → Acceptable cost — the shape we use is small (model, messages, max_tokens, chat_template_kwargs).

## Migration Plan

N/A — first commit, nothing to migrate from.

## Open Questions

None blocking. Items punted to later changes:
- Streaming responses (when CLI shows token-by-token output)
- JSON schema / structured output (L3 claim extraction)
- Embedding client (separate module, separate change)
- Retry/backoff (resilience layer)
