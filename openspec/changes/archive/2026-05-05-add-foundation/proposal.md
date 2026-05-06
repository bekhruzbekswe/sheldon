## Why

Sheldon is a long-running research agent built layer by layer. L0 is the floor: a TypeScript/Bun project skeleton and a thin LLM client that can talk to our Qwen3.5-9B llama.cpp server with both `fast()` (no-thinking) and `deep()` (thinking-on) modes. Without this foundation, every subsequent layer has nothing to call into.

This change introduces only what's strictly needed to call the LLM end-to-end and prove the pipe is alive. Everything else (event log, search, fact store, frontier, synthesis) belongs to later layers and their own change proposals.

## What Changes

- New TypeScript + Bun project at the repo root
- `package.json` with Bun runtime config and a single `hello` script
- `tsconfig.json` with strict mode
- An `.env` mechanism for the LLM endpoint URL and bearer token
- A `LlmClient` module exposing two methods:
  - `fast(messages, opts?)` — no thinking, for high-frequency calls
  - `deep(messages, opts?)` — thinking on, for synthesis-quality calls
- The client uses `fetch` directly (NOT the OpenAI SDK) so we control the User-Agent header — Cloudflare on `ai.mayoq.tech` blocks the SDK's default UA
- A `bun run hello` smoke test that calls both modes and prints timings + token counts

Out of scope: streaming, structured output, embeddings, search, scraping, persistence, anything agentic.

## Capabilities

### New Capabilities

- `llm-client`: Send chat-completion requests to an OpenAI-compatible endpoint with selectable thinking mode and a non-default User-Agent. Returns content, optional reasoning, token usage, and timing.

### Modified Capabilities

(none — first change)

## Impact

- Code: creates `src/llm.ts`, `src/index.ts`, `package.json`, `tsconfig.json`, `.env.example`, `.gitignore`
- Dependencies: `bun` (runtime), `@types/bun` (dev). No npm packages required for L0.
- External: requires `ai.mayoq.tech` to be reachable with the bearer token at run time. No changes requested of the server in this change (it's already configured for 32k context with `--jinja` per prior session work).
