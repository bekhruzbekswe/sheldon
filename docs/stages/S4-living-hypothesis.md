# S4 — Living hypothesis across iterations

> **Status: deferred — re-evaluate after S1–S3.**
> Highest-leverage idea in the original handoff (H3), but also the most architectural and the most uncertain. Don't build until S1–S3 ship and we can see what the gap actually looks like.

## Why this stage exists (or might not need to)

The original handoff's H3: *a real analyst forms a tentative answer early and spends remaining time testing/refining it. Sheldon only gathers, then synthesizes once at the end. There's no "what do I currently believe, and what would change my mind?"*

S2's thesis-drafter creates a thesis at synthesis time — late, one-shot, no opportunity for the agent to use the thesis to *guide* gathering. S3's gap analyzer runs at phase boundaries — better, but still episodic and not belief-revising. A living hypothesis is fundamentally different: an artifact the agent maintains throughout the run, updates as evidence comes in, and uses to direct what to gather next.

The reason this is deferred: **we don't yet know if S1+S2+S3 leave a quality gap that warrants this much architectural change.** The cost is real (every iteration gets an extra LLM call to update the hypothesis; the run-state schema becomes more complex; resume gets harder). The benefit may already be 80% delivered by S2's thesis + S3's gap analyzer. Build only if reports after S1–S3 still feel like gather-then-summarize rather than analyst-grade.

## Goal *(if this stage runs)*

Make the agent maintain a "current best answer" document that updates iteration-by-iteration. New evidence is read against the current answer with the question "does this change what I believe?" rather than "what's the next interesting thread to pull?". Synthesis becomes the final cleanup of an answer that has already been forming.

## Hypotheses included

- **H3 — Working hypothesis maintained across iterations.** A persistent artifact (`current_answer.md` analogue, stored on `run_state` or its own table) that the agent revises after each iteration's facts settle. Phase transitions include a hypothesis-revision step that consolidates.
- **Belief-driven proposer** *(downstream of H3)*. Once a living hypothesis exists, the proposer's prompt shifts from "given recent claims, propose follow-ups" to "given the current best answer and these new facts, what would most strengthen, weaken, or refine the answer?". This is the structural reason H3 is high-leverage.

## Capabilities

### New

- `working-hypothesis` — module owning the artifact. `getWorkingHypothesis()`, `reviseWorkingHypothesis(newFacts)`, `consolidateAtPhaseBoundary()`. Stored as JSON on `run_state` (or a new `working_hypothesis` table — decide at openspec design time based on size of revisions).

### Modified

- `followup-proposer` — input shape extends with the current working hypothesis. Prompt rewritten around "what would change this answer?".
- `research-contract` (from S1) — the working hypothesis can be seen as a *living* extension of the contract's `good_answer_contains`. May want to merge interfaces.
- `thesis-drafter` (from S2) — at synthesis time, becomes a finalize step: take the current working hypothesis and lock it down, instead of drafting from scratch. Most of the work has already been done across iterations.

## Dependencies

- **All of S1–S3.** The contract from S1 anchors what "good answer" means. The thesis-drafter from S2 is the natural pre-synthesis crystalliser of the living hypothesis. The gap analyzer from S3 is what the living hypothesis replaces in the structural sense — once you have a living hypothesis, gap analysis falls out of "what would change my answer?".

## Key data structures / decisions

**Working-hypothesis artifact (sketch):**

```json
{
  "current_answer": "string (5-12 sentences, mutable across iterations)",
  "claims": [
    {
      "claim": "string",
      "confidence": "low | medium | high",
      "supporting_fact_ids": [number],
      "open": "list of unresolved questions about this claim"
    }
  ],
  "uncertain": ["topic where evidence conflicts or is thin"],
  "would_change_my_mind": ["specific evidence that would force a revision"]
}
```

The `would_change_my_mind` field is the load-bearing piece — it's what the proposer optimizes against.

**Revision rhythm:** every N iterations (probably 3–5) or at phase boundaries, run a `consolidateAtPhaseBoundary` LLM call: "given the current hypothesis and these new N facts, what changes? produce the updated hypothesis." This is roughly an extra 5–10s every 3–5 iterations — substantial but not budget-killing.

**Resume implications:** the working hypothesis is on `run_state`, so resume reads it as-is. No special handling beyond the schema's existing JSON columns.

**Failure mode:** if revision diverges (the hypothesis flips wildly each iteration), that's a signal the corpus is too thin — flag it and bias toward more breadth gathering. Distinct from a gradual refinement, which is the desired behaviour.

## Deletion lens

- **The working hypothesis itself is a deletion mechanism for ideas.** Each revision can drop a claim that no longer holds, mark a sub-thread as resolved (no further investigation needed), or cap confidence on something that turned out weaker than thought.
- **Belief-driven proposer is a deletion of trajectories.** Threads that wouldn't change the current answer don't get pursued — by far the highest-leverage form of "drop weak content" because it happens *before* the content is even gathered.
- This is the deletion-lens-cleanest stage if it runs at all.

## Out of scope

- **Multi-agent disagreement / red-teaming.** Could imagine a "skeptic" pass that tries to break the working hypothesis; not S4. Future possibility.
- **Persistent cross-run knowledge.** Each run's hypothesis is per-run. No long-term memory across questions.
- **Live editability** (user inspects and edits the working hypothesis mid-run). Out of scope; the agent runs autonomously per the original Sheldon brief.

## Open questions

- **Is this needed at all after S1–S3?** Honest answer: maybe not. Decide after running fresh reports post-S3 against the bar in `README.md`.
- **What's the right revision cadence?** Per-iteration is too frequent (LLM-cost-ratio gets bad). Per-phase is too rare (the hypothesis doesn't get to *steer* gathering). Per-N-iterations with N=3–5 is a starting guess.
- **How to keep the hypothesis from drifting toward the LLM's prior instead of the corpus?** A real risk with revision — the LLM may "smooth" the hypothesis toward what feels reasonable rather than what the evidence supports. Counter: each revision call is constrained to changes-from-evidence-only with explicit fact IDs.
- **Could the thesis-drafter from S2 simply be called more often?** Plausibly, yes. That's a lighter-weight version of S4 and might be enough. Worth considering as a "S4-lite" before committing to the full hypothesis store.
- **Resume across hypothesis revisions** — does interruption mid-revision cause problems? Atomicity around the JSON write should handle it; revisit at openspec design time.

## Suggested openspec change name

`living-hypothesis` *(if it runs)*.
