/**
 * Payload → human-readable summary.
 *
 * The dashboard log expects one short string per event — this turns the
 * structured payload our agent emits into the kind of line a human can
 * skim in the firehose.
 */

import type { Event } from './events.ts';

type AnyPayload = Record<string, unknown>;

function p(ev: Event): AnyPayload {
  return (ev.payload && typeof ev.payload === 'object' ? ev.payload : {}) as AnyPayload;
}

function trunc(s: unknown, n: number): string {
  const str = String(s ?? '');
  if (str.length <= n) return str;
  return str.slice(0, n - 1) + '…';
}

function num(x: unknown): number {
  return typeof x === 'number' && Number.isFinite(x) ? x : 0;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

function hostnameOf(url: unknown): string {
  try {
    return new URL(String(url)).hostname;
  } catch {
    return String(url ?? '');
  }
}

export function formatEvent(ev: Event): string {
  const pay = p(ev);
  const err = typeof pay.error === 'string' ? pay.error : null;

  switch (ev.kind) {
    case 'llm.fast':
    case 'llm.deep': {
      if (err) return `${err.slice(0, 80)}`;
      const total = num(pay.total_tokens);
      const completion = num(pay.completion_tokens);
      const prompt = trunc(pay.prompt, 60);
      return prompt
        ? `"${prompt}" · ${completion}/${total} tok`
        : `${completion}/${total} tok`;
    }

    case 'search.query': {
      if (err) return `${trunc(pay.query, 60)} · ${err}`;
      return `q="${trunc(pay.query, 60)}" · ${num(pay.resultCount)} hits`;
    }

    case 'scrape.fetch': {
      const url = trunc(pay.url, 60);
      const chars = num(pay.charCount);
      return `${url} · ${fmtBytes(chars)}`;
    }
    case 'scrape.skip': {
      return `${trunc(pay.url, 60)} · ${trunc(pay.reason, 40)}`;
    }

    case 'chunk.split': {
      return `${trunc(pay.url, 50)} → ${num(pay.chunkCount)} chunks · ${num(pay.totalTokens)} tok`;
    }
    case 'embed.batch': {
      return `${num(pay.count)} vectors`;
    }
    case 'claim.extract': {
      if (err) return `${trunc(pay.sourceUrl, 50)} · ${err}`;
      const cc = num(pay.claimCount);
      const ac = num(pay.avgConfidence);
      return `${trunc(pay.sourceUrl, 50)} · ${cc} claims · avg ${ac.toFixed(2)}`;
    }

    case 'fact.write': {
      return `#${num(pay.id)} ${trunc(pay.claim, 70)}`;
    }
    case 'fact.dedupe': {
      const sim = num(pay.similarity);
      return `near-dup of #${num(pay.matchedId)} (sim ${sim.toFixed(2)}) · ${trunc(pay.claim, 50)}`;
    }
    case 'fact.dropped.irrelevant': {
      const score = num(pay.score);
      const ts = num(pay.taskSimilarity);
      const oos = num(pay.maxOosSimilarity);
      return `score ${score.toFixed(3)} (task ${ts.toFixed(2)} − oos ${oos.toFixed(2)}) · ${trunc(pay.claim, 50)}`;
    }
    case 'source.classified': {
      if (err) return `${trunc(pay.domain, 40)} · ${err}`;
      const promo = pay.promotionalIntent ?? '?';
      const prim = pay.primaryVsDerivative ?? '?';
      return `${trunc(pay.domain, 40)} · ${pay.sourceType ?? '?'} · promo=${promo} · ${prim}`;
    }
    case 'contract.drafted': {
      if (err) return `${err.slice(0, 80)}`;
      return `subq=${num(pay.subQuestionCount)} · good=${num(pay.goodAnswerCount)} · oos=${num(pay.outOfScopeCount)}`;
    }
    case 'contract.revised': {
      if (err) return `${pay.phaseTransition ?? '?'} · ${err.slice(0, 60)}`;
      const removed = Array.isArray(pay.removed) ? pay.removed.length : 0;
      const added = Array.isArray(pay.added) ? pay.added.length : 0;
      return `${pay.phaseTransition ?? '?'} · -${removed} +${added}`;
    }
    case 'gap.analyzed': {
      if (err) return `${pay.phaseTransition ?? '?'} · ${err.slice(0, 60)}`;
      return `${pay.phaseTransition ?? '?'} · proposed=${num(pay.gapsProposed)} · pushed=${num(pay.gapsPushed)} · deduped=${num(pay.gapsDeduped)}`;
    }

    case 'frontier.seed': {
      if (err) return `${err}`;
      return `${num(pay.seedCount)} seeds · avg ${num(pay.avgScore).toFixed(2)}`;
    }
    case 'frontier.push': {
      return `q#${num(pay.id)} "${trunc(pay.question, 60)}" · ${num(pay.score).toFixed(2)} · d${num(pay.depth)}`;
    }
    case 'frontier.dedupe': {
      return `near-dup of q#${num(pay.matchedId)} (sim ${num(pay.similarity).toFixed(2)}) · "${trunc(pay.question, 50)}"`;
    }
    case 'frontier.pop': {
      return `q#${num(pay.id)} "${trunc(pay.question, 60)}" · ${num(pay.score).toFixed(2)}`;
    }
    case 'frontier.done': {
      return `q#${num(pay.id)} done · +${num(pay.factsAdded)} facts (${num(pay.claimsExtracted)} claims)`;
    }
    case 'frontier.skip': {
      return `q#${num(pay.id)} skip · ${trunc(pay.reason, 60)}`;
    }

    case 'iteration.start': {
      return `iter ${num(pay.iteration)} · q#${num(pay.questionId)} · phase=${pay.phase ?? '?'}`;
    }
    case 'iteration.end': {
      return `iter ${num(pay.iteration)} · ${pay.outcome ?? '?'} · +${num(pay.factsAdded)} facts · +${num(pay.proposalsPushed)} q`;
    }

    case 'phase.transition': {
      return `${pay.from} → ${pay.to} · ${(num(pay.elapsedMs) / 1000).toFixed(0)}s elapsed`;
    }
    case 'run.start': {
      return `task: "${trunc(pay.task, 70)}" · budget ${(num(pay.durationMs) / 60000).toFixed(0)}m`;
    }
    case 'run.end': {
      return `${num(pay.iterations)} iters · ${num(pay.factsAdded)} facts · ${(num(pay.elapsedMs) / 60000).toFixed(0)}m`;
    }

    case 'cluster.computed': {
      return `k=${num(pay.k)} · ${num(pay.clusterCount)} clusters · sil ${num(pay.silhouette).toFixed(2)}`;
    }
    case 'thesis.drafted': {
      if (err) return `${err.slice(0, 80)}`;
      return `claims=${num(pay.claimCount)} · slice=${num(pay.factSliceSize)} · cap=${num(pay.facts_per_domain_cap)}`;
    }
    case 'claim.triangulated': {
      if (err) return `${trunc(pay.claimHeadline, 40)} · ${err}`;
      const cor = num(pay.corroborations);
      const con = num(pay.contradictions);
      const contested = pay.contested ? ' contested' : '';
      return `${trunc(pay.claimHeadline, 40)} · +${cor} / -${con}${contested} · q=${num(pay.queriesRan)}`;
    }
    case 'section.rubric': {
      if (err) return `${trunc(pay.headline, 40)} · ${err}`;
      const flags = [
        pay.hasMechanism ? 'mech' : '·',
        pay.hasExample ? 'ex' : '·',
        pay.hasQuantification ? 'q' : '·',
        pay.defendsHeading ? 'def' : '·',
      ].join('|');
      return `${trunc(pay.headline, 40)} · ${flags}`;
    }
    case 'section.written': {
      if (err) return `${pay.label} · ${err}`;
      return `${pay.label} · ${num(pay.wordCount)}w · ${num(pay.citationCount)} cites`;
    }
    case 'section.dropped': {
      return `${trunc(pay.headline, 40)} · ${trunc(pay.reason, 60)}`;
    }
    case 'synthesis.fallback': {
      return `${pay.reason ?? '?'} · facts=${num(pay.factCount)}`;
    }
    case 'report.written': {
      return `${trunc(pay.path, 60)} · ${num(pay.sectionCount)} sections · ${fmtBytes(num(pay.bytes))}`;
    }

    case 'resume.detected': {
      return `task="${trunc(pay.task, 50)}" · phase=${pay.phase} · ${(num(pay.ageMs) / 60000).toFixed(0)}m ago`;
    }
    case 'resume.applied': {
      return `reset ${num(pay.questionsResetCount)} · facts before=${num(pay.factsBefore)} · phase=${pay.currentPhase}`;
    }

    default: {
      // Should never happen — taxonomy is closed at compile time.
      return JSON.stringify(pay).slice(0, 80);
    }
  }
}

export function isErrorEvent(ev: Event): boolean {
  const pay = p(ev);
  return typeof pay.error === 'string' && pay.error.length > 0;
}
