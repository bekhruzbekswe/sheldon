# Sheldon

A long-running, deadline-bounded research agent. You give it a question and a deadline ("top pain points of the AI age, 5 hours"); it researches autonomously and delivers a written report when the timer expires.

Designed to run on a single machine with a local LLM, with full live visibility into what it's doing, and crash-resumable state.

## Status

L8 complete. Sheldon now ships a friendly browser dashboard: `bun run dashboard` opens a Hono server at `http://127.0.0.1:4000` rendering the Claude-Design HTML against real data — phase progress, the running question with a 4-step staircase pipeline, frontier queue, live facts feed, sparkline stats, and the firehose event log via SSE. Read-only, localhost-only. The agent itself is feature-complete: task + deadline → autonomous research → finished report → live visibility while it runs. v1 done.

## Getting oriented

- **What this is and how it works**: see [`AGENTS.md`](./AGENTS.md).
- **Bird's-eye architecture (L0–L8 + v2 synthesis pipeline)**: [`docs/architecture.md`](./docs/architecture.md).
- **Forward-looking initiatives (not yet promoted to openspec)**: [`docs/initiatives/`](./docs/initiatives/).
- **Current change in flight**: `openspec list` (or `openspec view` for an interactive dashboard).
- **Stable specs (built behaviors)**: `openspec/specs/`.
- **Active proposals (in-flight work)**: `openspec/changes/`.

## Stack

- **Runtime**: Bun + TypeScript
- **LLM**: Qwen3.5-9B Q4_K_M served by llama.cpp at `ai.mayoq.tech` (32k ctx, thinking-toggle)
- **Embeddings**: `@xenova/transformers` (in-process, no Python)
- **Search**: SearXNG (sibling repo's docker-compose)
- **Scrape**: `@mozilla/readability` + `jsdom`
- **DB**: `better-sqlite3` (frontier queue + fact store)
- **Output**: `report.md` to disk

## Build philosophy

Layered. Each layer runs end-to-end on its own. After each: review, decide if the next layer's plan still makes sense, adjust. No big-bang.

Layer index:
- **L0** Foundation — LLM client (fast/deep), repo scaffold *(done — change `add-foundation`)*
- **L1** Visibility primitive — JSONL event log + colored tail *(done — change `add-event-log`)*
- **L2** Single search loop — question → SearXNG → scrape → summarize *(done — change `add-search-loop`)*
- **L3** Fact store — SQLite, claim extraction, embeddings *(done — change `add-fact-store`)*
- **L4** Frontier queue — propose follow-ups, score, pop *(done — change `add-frontier-queue`)*
- **L5** Time budget + phases — wall-clock deadline, synthesis trigger *(done — change `add-phase-machine`)*
- **L6** Synthesis — cluster facts, write sectioned report *(done — change `add-synthesis`)*
- **L7** Resume + crash recovery *(done — change `add-resume`)*
- **L8** Live web dashboard *(done — change `add-dashboard`)*
