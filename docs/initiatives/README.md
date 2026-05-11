# Initiatives

Forward-looking planning docs for multi-change efforts that haven't been promoted to openspec yet. Each file is the "why + scope" of an effort that will spawn 1–N openspec changes.

**This directory holds intent, not history.** Once an initiative ships, delete its file (or trim to a one-liner). Audit trail lives in `openspec/changes/archive/`. Stable architecture lives in [`../architecture.md`](../architecture.md).

## Conventions

- Name by goal, not by sequence number (`living-hypothesis`, not `S4`). Initiatives are named for what they do; "stage 5" tells the reader nothing.
- Each file roughly answers: **why this initiative exists**, **what changes if it ships**, **what's deliberately out of scope**, **what's still uncertain**.
- When promoting to openspec: `openspec new change <kebab-name>` and write the proposal against current reality, not the initiative doc — the doc is orientation, not spec.
- Re-evaluate before committing. Initiatives written months ago against a v1 system may be obsoleted by what v2 already delivers.

## Currently live

- [`living-hypothesis.md`](./living-hypothesis.md) — deferred. Maintain a working hypothesis across iterations so gathering is belief-driven rather than topic-driven. Re-evaluate after the first real-task run on v2.
