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

  const recentFacts = factStore.list({ limit: RECENT_CLAIMS_FOR_PROPOSER });
  const recentClaims = recentFacts.map((f) => f.claim);
  const pendingTitles = frontier.listPending(5).map((p) => p.question);

  const proposals = await proposer.propose({
    originalTask,
    parentQuestion: popped.question,
    recentClaims,
    pendingTitles,
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

  try {
    if (!opts.resume) {
      questionsSeeded = await seedFrontier(task, seedCount);
    }

    while (iterations < maxIters && !isSynthesis()) {
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
    }
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
