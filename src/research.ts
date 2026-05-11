/**
 * L4+L5 research loop. Decompose → seed frontier → loop.
 *
 * The loop runs until ANY of: synthesis phase fires, frontier exhausted, or
 * maxIters cap hit. Phase checkpoints inside processIteration short-circuit
 * remaining work the moment synthesis is reached.
 */

import { decomposer } from './decompose.ts';
import { proposer } from './propose.ts';
import { frontier } from './frontier.ts';
import { embedder } from './embed.ts';
import { score, computeNovelty } from './score.ts';
import { searxngClient } from './search.ts';
import { scraper, type ScrapeOk } from './scrape.ts';
import { indexSource } from './loop.ts';
import { factStore } from './facts.ts';
import { events } from './events.ts';
import { phaseMachine, runStart, runEnd, seedPhaseCache, getRunState, type Phase } from './phase.ts';
import { synthesize } from './synthesize.ts';
import { resetInProgressFrontier } from './resume.ts';
import { getTaskEmbedding, getContract, reviseContract } from './contract.ts';
import { extractDomain } from './classify.ts';
import { analyzeGaps } from './gap.ts';

export type ResearchOptions = {
  maxIters?: number;
  seedCount?: number;
  /** Absolute unix-ms deadline. If omitted, deadline is 24h out (effectively "no clock"). */
  deadlineAt?: number;
  /** Resume an existing run. When true, deadlineAt and seedCount are ignored. */
  resume?: boolean;
};

export type ResearchSummary = {
  task: string;
  iterations: number;
  factsAddedTotal: number;
  claimsExtractedTotal: number;
  questionsSeeded: number;
  questionsProposed: number;
  proposalsDeduped: number;
  pendingRemaining: number;
  phaseReached: Phase;
  elapsedMs: number;
  reportPath?: string;
};

const TOP_N = 3;
const RECENT_CLAIMS_FOR_PROPOSER = 8;
const PROPOSER_DOMAIN_CAP = 2;
const SATURATION_FRACTION = 0.40;
const SATURATION_MIN_COUNT = 5;
const REVISE_DROPPED_SAMPLE_SIZE = 10;
const REVISE_BORDERLINE_SAMPLE_SIZE = 10;

function isSynthesis(): boolean {
  try {
    return phaseMachine.now() === 'synthesis';
  } catch {
    return false;
  }
}

function currentPhase(): Phase {
  try {
    return phaseMachine.now();
  } catch {
    return 'breadth';
  }
}

async function seedFrontier(task: string, count: number): Promise<number> {
  const seeds = await decomposer.decompose(task, { count });
  if (seeds.length === 0) return 0;

  const embeddings = await embedder.embed(seeds.map((s) => s.question));
  const phase = currentPhase();

  let pushed = 0;
  for (let i = 0; i < seeds.length; i++) {
    const s = seeds[i]!;
    const embedding = embeddings[i]!;
    const novelty = computeNovelty(embedding, frontier.allEmbeddings());
    const finalScore = score({ relevance: s.score, novelty, depth: 0, phase });
    const id = await frontier.push({
      question: s.question,
      score: finalScore,
      depth: 0,
      embedding,
    });
    if (id !== null) pushed++;
  }
  return pushed;
}

type IterationResult = {
  factsAdded: number;
  claimsExtracted: number;
  proposalsPushed: number;
  proposalsDeduped: number;
  scrapedCount: number;
  shortCircuited: boolean;
};

async function processIteration(
  iterationNumber: number,
  popped: { id: number; question: string; depth: number },
  originalTask: string,
): Promise<IterationResult> {
  await events.emit({
    kind: 'iteration.start',
    layer: 'L4',
    payload: {
      iteration: iterationNumber,
      questionId: popped.id,
      question: popped.question.slice(0, 80),
      depth: popped.depth,
      phase: currentPhase(),
    },
  });

  const result: IterationResult = {
    factsAdded: 0,
    claimsExtracted: 0,
    proposalsPushed: 0,
    proposalsDeduped: 0,
    scrapedCount: 0,
    shortCircuited: false,
  };

  // 1. Search.
  const results = await searxngClient.query(popped.question);
  if (isSynthesis()) {
    result.shortCircuited = true;
    await emitIterationEnd(iterationNumber, popped.id, result, 'synthesis-after-search');
    return result;
  }
  const top = results.slice(0, TOP_N);

  // 2. Scrape (parallel).
  const scraped = await Promise.all(top.map((r) => scraper.fetch(r.url)));
  if (isSynthesis()) {
    result.shortCircuited = true;
    await emitIterationEnd(iterationNumber, popped.id, result, 'synthesis-after-scrape');
    return result;
  }
  const sources = scraped.filter((s): s is ScrapeOk => s !== null);
  if (sources.length === 0) {
    await emitIterationEnd(iterationNumber, popped.id, result, 'no-sources');
    return result;
  }

  // 3. Index each source. Checkpoint after each source so we can bail mid-list.
  for (const source of sources) {
    if (isSynthesis()) {
      result.shortCircuited = true;
      break;
    }
    const outcome = await indexSource(source, popped.question, popped.id);
    result.factsAdded += outcome.factsAdded;
    result.claimsExtracted += outcome.claimsExtracted;
    result.scrapedCount++;
  }

  if (result.shortCircuited) {
    await emitIterationEnd(iterationNumber, popped.id, result, 'synthesis-during-index');
    return result;
  }

  // 4. Propose follow-ups based on what we learned.
  if (isSynthesis()) {
    result.shortCircuited = true;
    await emitIterationEnd(iterationNumber, popped.id, result, 'synthesis-before-propose');
    return result;
  }

  const taskRelevantClaims = buildTaskRelevantSlice(RECENT_CLAIMS_FOR_PROPOSER, PROPOSER_DOMAIN_CAP);
  const pendingTitles = frontier.listPending(5).map((p) => p.question);
  const saturatedDomains = getSaturatedDomains(SATURATION_FRACTION, SATURATION_MIN_COUNT);

  const proposals = await proposer.propose({
    originalTask,
    parentQuestion: popped.question,
    taskRelevantClaims,
    pendingTitles,
    ...(saturatedDomains.length > 0 ? { saturatedDomains } : {}),
  });

  if (proposals.length > 0) {
    const proposalEmbeddings = await embedder.embed(proposals.map((p) => p.question));
    const phase = currentPhase();
    for (let i = 0; i < proposals.length; i++) {
      const p = proposals[i]!;
      const embedding = proposalEmbeddings[i]!;
      const existing = frontier.allEmbeddings();
      const novelty = computeNovelty(embedding, existing);
      const childDepth = popped.depth + 1;
      const finalScore = score({ relevance: p.relevance, novelty, depth: childDepth, phase });
      const id = await frontier.push({
        question: p.question,
        score: finalScore,
        parentId: popped.id,
        depth: childDepth,
        embedding,
      });
      if (id === null) result.proposalsDeduped++;
      else result.proposalsPushed++;
    }
  }

  await emitIterationEnd(iterationNumber, popped.id, result, 'completed');
  return result;
}

/**
 * Build the proposer's input slice — task-relevance-sampled with a per-domain cap.
 * Replaces the legacy recency-sorted `factStore.list({limit:N})` call. Falls back
 * to recency on partial-state runs (no cached task embedding).
 */
function buildTaskRelevantSlice(limit: number, maxPerDomain: number): string[] {
  const taskEmb = getTaskEmbedding();
  if (!taskEmb) {
    // Defensive carve-out: contract drafting failed early, no embedding cached.
    return factStore.list({ limit }).map((f) => f.claim);
  }
  const candidates = factStore.findSimilar(taskEmb, { topK: limit * 2, minSim: 0 });
  const picked: string[] = [];
  const perDomain = new Map<string, number>();
  for (const c of candidates) {
    if (picked.length >= limit) break;
    let domain = '';
    try {
      domain = extractDomain(c.sourceUrl);
    } catch {
      domain = '';
    }
    const count = perDomain.get(domain) ?? 0;
    if (count >= maxPerDomain) continue;
    picked.push(c.claim);
    perDomain.set(domain, count + 1);
  }
  // If the similarity-based pick came up short, top up from recency-sorted list.
  if (picked.length < limit) {
    const seen = new Set(picked);
    for (const f of factStore.list({ limit })) {
      if (picked.length >= limit) break;
      if (seen.has(f.claim)) continue;
      picked.push(f.claim);
    }
  }
  return picked;
}

/**
 * Roll up domain frequencies in the fact store and return domains that are
 * over-represented. Used as a hint to the proposer (S3 domain-diversity bias).
 */
function getSaturatedDomains(thresholdFraction: number, minCount: number): string[] {
  const all = factStore.list({ limit: 10_000 }); // bounded query; runs O(n) in JS afterward
  if (all.length === 0) return [];
  const total = all.length;
  const counts = new Map<string, number>();
  for (const f of all) {
    let domain = '';
    try {
      domain = extractDomain(f.sourceUrl);
    } catch {
      continue;
    }
    if (!domain) continue;
    counts.set(domain, (counts.get(domain) ?? 0) + 1);
  }
  const out: string[] = [];
  for (const [domain, count] of counts) {
    if (count / total > thresholdFraction || count > minCount) {
      out.push(domain);
    }
  }
  return out;
}

/**
 * Run gap analysis + contract revision for one named transition. Side-effects
 * push new frontier rows (gap analysis) and mutate `run_state.contract_json`
 * (contract revision). Skips gap analysis when the destination phase is
 * 'synthesis' (frontier is locked there; new seeds wouldn't be processed).
 * Always emits the corresponding events.
 */
async function runOneBoundary(
  transition: string,
  destPhase: Phase,
  task: string,
): Promise<void> {
  const contract = getContract();
  const facts = factStore.listAllWithEmbeddings();

  if (destPhase !== 'synthesis') {
    try {
      await analyzeGaps(transition, task, contract, facts, destPhase);
    } catch (err) {
      console.error(`[research] gap analysis failed at ${transition}: ${(err as Error).message}`);
    }
  }

  if (contract) {
    try {
      const droppedSamples: Parameters<typeof reviseContract>[2] = [];
      const taskEmb = getTaskEmbedding();
      const borderlineSamples: Parameters<typeof reviseContract>[3] = taskEmb
        ? facts
            .map((f) => {
              let s = 0;
              const len = Math.min(f.embedding.length, taskEmb.length);
              for (let i = 0; i < len; i++) s += f.embedding[i]! * taskEmb[i]!;
              return { claim: f.claim, score: s };
            })
            .sort((a, b) => a.score - b.score)
            .slice(0, REVISE_BORDERLINE_SAMPLE_SIZE)
        : [];
      void REVISE_DROPPED_SAMPLE_SIZE;
      await reviseContract(transition, contract, droppedSamples, borderlineSamples);
    } catch (err) {
      console.error(`[research] contract revision failed at ${transition}: ${(err as Error).message}`);
    }
  }
}

/**
 * Phase-boundary hook: walk every boundary that has been crossed since the last
 * observation and run gap analysis + contract revision for each. Mirrors the
 * phaseMachine's behaviour of synthesizing events for skipped transitions when
 * a long iteration spans multiple boundaries.
 *
 * Returns the new lastObservedPhase value.
 */
async function maybeRunBoundaryHook(
  task: string,
  current: Phase,
  lastObserved: Phase,
): Promise<Phase> {
  if (current === lastObserved) return lastObserved;
  const order: Phase[] = ['breadth', 'depth', 'synthesis'];
  const fromIdx = order.indexOf(lastObserved);
  const toIdx = order.indexOf(current);
  if (fromIdx < 0 || toIdx <= fromIdx) return current;
  let cursor = lastObserved;
  for (let i = fromIdx + 1; i <= toIdx; i++) {
    const next = order[i]!;
    const transition = `${cursor}->${next}`;
    await runOneBoundary(transition, next, task);
    cursor = next;
  }
  return current;
}

async function emitIterationEnd(
  iteration: number,
  questionId: number,
  result: IterationResult,
  outcome: string,
): Promise<void> {
  await events.emit({
    kind: 'iteration.end',
    layer: 'L4',
    payload: {
      iteration,
      questionId,
      outcome,
      factsAdded: result.factsAdded,
      claimsExtracted: result.claimsExtracted,
      sourcesUsed: result.scrapedCount,
      proposalsPushed: result.proposalsPushed,
      proposalsDeduped: result.proposalsDeduped,
      shortCircuited: result.shortCircuited,
    },
  });
}

export async function runResearch(
  task: string,
  opts: ResearchOptions = {},
): Promise<ResearchSummary> {
  const maxIters = opts.maxIters ?? Number.POSITIVE_INFINITY;
  const seedCount = opts.seedCount ?? 12;
  const startedAt = Date.now();

  let iterations = 0;
  let factsAddedTotal = 0;
  let claimsExtractedTotal = 0;
  let questionsProposed = 0;
  let proposalsDeduped = 0;
  let questionsSeeded = 0;

  // Setup: either start fresh (runStart + seedFrontier) or resume an existing
  // run (no runStart, reset in-progress frontier rows, seed the phase cache).
  if (opts.resume) {
    const state = getRunState();
    if (!state) {
      throw new Error('runResearch(resume): no run_state row found');
    }
    const factsBefore = factStore.count();
    const frontierBefore = frontier.count();
    const questionsResetCount = resetInProgressFrontier();
    const restorePhase = state.phase === 'done' ? 'synthesis' : state.phase;
    seedPhaseCache(restorePhase);
    await events.emit({
      kind: 'resume.applied',
      layer: 'L7',
      payload: {
        questionsResetCount,
        currentPhase: restorePhase,
        factsBefore,
        frontierBefore,
      },
    });
  } else {
    // Default deadline: 24h out, so phase stays in 'breadth' the whole run if no
    // deadline was provided. This preserves L4 behavior under `--max-iters`-only.
    const deadlineAt = opts.deadlineAt ?? startedAt + 24 * 3600 * 1000;
    await runStart(task, deadlineAt);
  }

  // S3 phase-boundary hook state. On resume, seed from the recovered phase to
  // prevent a spurious boundary-hook fire on the first iteration after restart.
  let lastObservedPhase: Phase = opts.resume
    ? ((getRunState()?.phase as Phase | 'done' | undefined) === 'done'
        ? 'synthesis'
        : ((getRunState()?.phase as Phase | undefined) ?? 'breadth'))
    : 'breadth';

  try {
    if (!opts.resume) {
      questionsSeeded = await seedFrontier(task, seedCount);
    }

    while (iterations < maxIters && !isSynthesis()) {
      // Before popping the next question, check for a phase transition and run
      // the S3 boundary hook (gap analysis + contract revision) if needed.
      lastObservedPhase = await maybeRunBoundaryHook(task, currentPhase(), lastObservedPhase);

      const popped = await frontier.pop();
      if (!popped) break;

      iterations++;
      try {
        const result = await processIteration(
          iterations,
          { id: popped.id, question: popped.question, depth: popped.depth },
          task,
        );
        factsAddedTotal += result.factsAdded;
        claimsExtractedTotal += result.claimsExtracted;
        questionsProposed += result.proposalsPushed;
        proposalsDeduped += result.proposalsDeduped;
        if (result.shortCircuited) {
          await frontier.markSkipped(popped.id, 'synthesis trigger fired mid-iteration');
        } else if (result.claimsExtracted === 0 || result.scrapedCount === 0) {
          await frontier.markSkipped(
            popped.id,
            result.scrapedCount === 0 ? 'no usable sources' : 'no claims extracted',
          );
        } else {
          await frontier.markDone(popped.id, {
            factsAdded: result.factsAdded,
            claimsExtracted: result.claimsExtracted,
          });
        }
      } catch (err) {
        console.error(`[research] iteration ${iterations} failed: ${(err as Error).message}`);
        await frontier.markSkipped(popped.id, `error: ${(err as Error).message}`);
      }

      // S3 boundary hook: also check at end-of-iteration so transitions that
      // happened mid-iteration (long iteration spanning a boundary) get processed.
      lastObservedPhase = await maybeRunBoundaryHook(task, currentPhase(), lastObservedPhase);
    }

    // Catch any boundaries crossed in the last iteration but not yet processed
    // (e.g., depth→synthesis where the iteration short-circuited and the loop
    // exited without re-entering the body).
    lastObservedPhase = await maybeRunBoundaryHook(task, currentPhase(), lastObservedPhase);
  } finally {
    const phaseReached = currentPhase();
    await runEnd({
      iterations,
      factsAdded: factsAddedTotal,
      claimsExtracted: claimsExtractedTotal,
      questionsSeeded,
      questionsProposed,
      proposalsDeduped,
      phaseReached,
    });
  }

  const pendingRemaining = frontier.listPending(1000).length;

  // L6: synthesize a report if we exited in synthesis phase and there's
  // anything to write about. Errors here are isolated — a failed synthesis
  // must not poison the run summary.
  let reportPath: string | undefined;
  try {
    if (currentPhase() === 'synthesis' && factsAddedTotal > 0) {
      const result = await synthesize();
      if (result) reportPath = result.reportPath;
    }
  } catch (err) {
    console.error(`[research] synthesis failed: ${(err as Error).message}`);
  }

  return {
    task,
    iterations,
    factsAddedTotal,
    claimsExtractedTotal,
    questionsSeeded,
    questionsProposed,
    proposalsDeduped,
    pendingRemaining,
    phaseReached: currentPhase(),
    elapsedMs: Date.now() - startedAt,
    ...(reportPath ? { reportPath } : {}),
  };
}
