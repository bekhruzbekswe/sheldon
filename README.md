# Sheldon

A research agent that runs for hours.

You give it a question and a deadline. It works while you're at the gym, asleep, or in another meeting. When you come back, there's a cited Markdown report waiting — and a localhost dashboard showing every search, claim, and clustering decision it made to get there.

Built to run on one machine with a local LLM. No cloud account required. The agent dies and resumes from where it stopped. Every run is reproducible from two SQLite tables and a JSONL log.

---

```bash
bun run research "what changed in robotics foundation models in the last 6 months" --deadline 2h
```

Watch it on `http://127.0.0.1:4000` if you want. Or close the laptop. When the timer hits zero, you have `report.md`: 4–7 load-bearing claims, each backed by triangulated sources, written as paragraphs an analyst would write — not a wall of bullets.

## Why this exists

Most "agents" are still chat-shaped. You wait 30 seconds, get one answer, ask again. That's fine for "what's the syntax for X." It's a bad fit for "research this for me."

A real research session is: form a tentative thesis, gather evidence, change your mind, re-gather, drop the parts that didn't pan out, write the thing. It takes hours. It involves cutting more than collecting. Sheldon is an attempt to give an LLM the shape of that work, with hard rules about evidence, citations, and what the answer should look like before you start gathering.

## How it works

```
your question + deadline
   │
   ▼
breadth phase   (~30% of clock)  — decompose into seed questions, cast a wide net
   │
depth phase     (~50% of clock)  — drill into the best-scored threads, propose follow-ups
   │
synthesis phase (~20% of clock)  — no more searching. Draft a thesis. Triangulate each
                                   claim. Write a section per claim. Drop sections that
                                   fail the rubric. Stitch into a cited report.
```

State lives in two SQLite tables — a **frontier queue** of scored questions and a **fact store** of atomic claims with embeddings and source tiers. Every step writes a line to an append-only JSONL event log. A separate Hono process tails the log and streams it to a localhost dashboard. Nothing in the research loop reads the dashboard — kill it, restart it, the run keeps going.

Full architecture in [`docs/architecture.md`](./docs/architecture.md). Per-capability contracts in [`openspec/specs/`](./openspec/specs/).

## Quickstart (~5 minutes)

You'll need: [Bun](https://bun.sh), an OpenAI-compatible LLM endpoint, and a SearXNG instance.

```bash
git clone <repo> sheldon && cd sheldon
bun install
cp .env.example .env
$EDITOR .env   # point LLM_BASE_URL + LLM_MODEL at any OpenAI-compatible endpoint
               # — llama.cpp, Ollama, vLLM, OpenRouter, Together — all work
```

Don't have a SearXNG instance handy? The [searxng-docker](https://github.com/searxng/searxng-docker) repo will give you one in two minutes; point `SEARXNG_BASE_URL` at it.

Then:

```bash
bun run research "what's actually new in fusion energy commercialization, 2024-2026" --deadline 30m
bun run dashboard   # in another tab — open http://127.0.0.1:4000
```

When the deadline fires, the report writes to `.sheldon/reports/<run-id>.md` (also symlinked at `latest.md`). If the process dies mid-run, `bun run research --resume` picks it up with the same deadline, frontier, and fact store.

## The dashboard

A single self-contained `web/index.html`. Vanilla JS, no bundler, no framework. Shows:

- Current phase and time remaining on the clock
- The frontier queue, sorted by score
- The fact store, filterable by topic tag and source tier
- A live event firehose: LLM calls, searches, scrapes, fact writes, phase transitions, dropped sections
- The thesis once synthesis fires, and which claims are contested

Read-only, localhost-only, GET-only. Non-GET is 405. It's a control room, not a UI.

## Make it yours

The interesting customizations don't require touching the loop:

- **Use a different model.** Change `LLM_MODEL` in `.env`. Anything OpenAI-compatible works.
- **Change the phases.** The `0/30/80/100%` split lives in `src/phase.ts`.
- **Edit the rubric.** Sections that fail the rubric get one revision then dropped. Criteria in `openspec/specs/section-rubric/spec.md` and `src/rubric.ts`.
- **Re-tier sources.** Every scraped domain is sorted into `rigorous / mixed / marketing / aggregator`. The classifier prompt is in `src/classify.ts`; tiers feed back into scoring and triangulation.
- **Change the report shape.** The stitcher is pure functions in `src/synthesize.ts` — swap intro/conclusion templates, change citation style, render to a different format.

The bigger customizations want a new capability:

- A new evidence source (arXiv, Reddit, your private RSS)
- A new phase (e.g. `verify` between depth and synthesis)
- A different embedding model
- Swap brute-force cosine for `sqlite-vec`

There's a workflow for that. `openspec new change <name>` scaffolds the proposal, design, specs delta, and tasks. See [`AGENTS.md`](./AGENTS.md) for the loop.

## Stack

- **Runtime** — Bun + TypeScript
- **LLM** — any OpenAI-compatible endpoint (developed against llama.cpp serving Qwen3.5-9B at 32k ctx; tested with Ollama / OpenRouter)
- **Embeddings** — `@xenova/transformers` (`all-MiniLM-L6-v2`, in-process, no Python)
- **Search** — SearXNG
- **Scrape** — `@mozilla/readability` + `jsdom`
- **DB** — `bun:sqlite` (WAL)
- **Dashboard** — Hono + SSE, vanilla JS frontend

## Honest about quality

Sheldon is a working system, not a magic one. Things to know going in:

- **Reports are "smart-analyst draft" quality, not "expert publication" quality.** They lead with a thesis and defend it with citations, but you'll occasionally see clumsy citation density (`[3][3][3]`) or a section that should have been cut. The rubric catches most of it. Not all of it.
- **`llm.deep` (chain-of-thought mode) is currently off.** Qwen3.5-9B in thinking mode spends its entire output budget on `reasoning_content` and returns zero content tokens. Every call uses `llm.fast`. Documented in [L0 notes](./docs/architecture.md). Wire up a different model and deep mode comes back for free.
- **Vector similarity is brute-force cosine in JS.** Fine up to ~10k facts. Past that, swap to `sqlite-vec`.
- **No retries on flaky upstreams.** A SearXNG hiccup or a 502 from the LLM endpoint drops one iteration. The frontier just moves on.

What it does well: stays on-task for hours, runs against a model on your own hardware, every claim in the report traces back to a URL, the whole run is debuggable from one JSONL file, and crashes don't lose work.

## Status

| Version | What shipped |
|---|---|
| **v1** (L0–L8) | Layered build: LLM client → event log → search loop → fact store → frontier queue → phase machine → synthesis → resume → dashboard. Question + deadline → autonomous research → cited report. |
| **v2** | Research contract, source classifier, thesis-driven synthesis, gap analyzer, rubric. Sharper reports without changing the layered shape. |

Deferred but documented: a **living hypothesis** maintained across iterations so gathering becomes belief-driven rather than topic-driven. See [`docs/initiatives/living-hypothesis.md`](./docs/initiatives/living-hypothesis.md). Open invitation if it interests you.

## Contributing

Built around [OpenSpec](https://github.com/Fission-AI/OpenSpec). Every capability has a stable spec in `openspec/specs/<capability>/`. Every in-flight change lives in `openspec/changes/<name>/` with proposal, design, specs delta, and tasks. Archived changes form the audit trail in `openspec/changes/archive/`.

A new contributor's first PR usually looks like:

```bash
openspec new change <kebab-name>     # scaffolds the workspace
# edit proposal, design, specs delta, tasks
/opsx:apply <name>                   # implement; mark tasks done as you go
openspec validate <name>             # gate before archiving
/opsx:archive <name>                 # syncs spec, moves to archive/
```

[`AGENTS.md`](./AGENTS.md) is the orientation document. Written for AI coding sessions, but reads cleanly for humans.

## License

[MIT](./LICENSE).
