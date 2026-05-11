/**
 * Gap analyzer (L4). At each phase boundary (breadth→depth, depth→synthesis),
 * one llm.fast call asks "what important angles are missing?" given the task,
 * the contract, and a sampled cross-section of facts. The returned questions
 * are pushed onto the frontier as fresh seeds (depth=0).
 *
 * The synthesis-orchestrator skips the depth→synthesis call when the frontier
 * is already locked.
 */

import { llm, type Message } from './llm.ts';
import { embedder } from './embed.ts';
import { events } from './events.ts';
import { extractDomain } from './classify.ts';
import { getTaskEmbedding, type ResearchContract } from './contract.ts';
import { frontier } from './frontier.ts';
import { score, computeNovelty } from './score.ts';
import type { Phase } from './phase.ts';

export type Gap = {
  question: string;
  relevance: number;
  why: string;
};

type FactWithEmbedding = {
  id: number;
  claim: string;
  sourceUrl: string;
  embedding: Float32Array;
};

const GAP_SLICE_SIZE = 40;
const GAP_MAX_PER_DOMAIN = 3;
const MAX_GAPS = 5;

const SYSTEM_PROMPT = `You identify missing angles in an active research run at a phase boundary. The agent has gathered some facts; you decide what important angles are NOT yet covered.

OUTPUT FIELDS (per gap)
- question: a CONCRETE, searchable question that could meaningfully be answered by a search engine. Specific subject + specific angle. Examples: "How is TCS's outcome-based pricing structured for AI work?", "What is the GCC adoption rate among Fortune 500 companies in 2025?".
- relevance: a number in [0, 1] reflecting how central this angle is to the original research task.
- why: one short line explaining what's currently missing in the corpus that justifies this question.

RULES
- Do NOT restate the contract's existing sub_questions. The goal is to surface what's MISSING, not to repeat what's already being investigated.
- Generic meta-questions are FORBIDDEN ("What other angles should we explore?", "Is there more to know?", "Can you find more case studies?"). The agent can't search for vague meta.
- Each gap must name at least one of: a specific entity, a specific time period, a specific mechanism, or a specific quantitative target.
- Use the <good_answer_contains> guidance: if items there have NO supporting evidence in the gathered facts, those are prime candidates for gaps.
- Use the <out_of_scope> list to AVOID proposing gaps that drift away from the question.
- Output 3-5 gaps. Quality over quantity — fewer specific gaps beat more generic ones.

PRIORITY ANGLES
Consider these priority angles when they're relevant to the task. They are NOT mandatory — if a category doesn't apply to the task's domain (e.g., a question about a scientific concept where named players don't exist), skip it. But if the task DOES have these angles available and they're not yet in the corpus, prioritize them:

- Specific named industry players relevant to the task's industry, with concrete questions about their actual responses, revenue impact, or strategic shifts. (For example, on a question about outsourcing in the AI age, Tata Consultancy Services / Infosys / Accenture / Cognizant / Wipro / Genpact are all named players whose specific responses are highly informative. The corpus is often missing direct evidence about named incumbents' moves.)
- Specific quantitative figures from named companies, regulators, or analyst firms (revenue percentages, headcount changes, contract counts, market-share moves).
- Concrete time-bounded events (e.g., "since the EU AI Act took effect…", "in Q3 2025…", "after the OpenAI-Oracle deal…").
- Adjacencies the contract's good_answer_contains items name but the corpus doesn't yet contain.

OUTPUT
Return JSON: {"gaps": [{"question": "...", "relevance": 0.X, "why": "..."}, ...]}.`;

const RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'gaps',
    schema: {
      type: 'object',
      properties: {
        gaps: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              question: { type: 'string' },
              relevance: { type: 'number' },
              why: { type: 'string' },
            },
            required: ['question', 'relevance', 'why'],
          },
        },
      },
      required: ['gaps'],
    },
  },
} as const;

function dot(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i]! * b[i]!;
  return s;
}

function trunc(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}

/**
 * Task-relevance-sorted, source-diverse slice. Mirrors thesize.ts's selectSlice
 * shape but uses gap-specific constants.
 */
function selectGapSlice(
  facts: FactWithEmbedding[],
  taskEmbedding: Float32Array,
): FactWithEmbedding[] {
  const scored = facts.map((f) => ({ fact: f, score: dot(f.embedding, taskEmbedding) }));
  scored.sort((a, b) => b.score - a.score);
  const picked: FactWithEmbedding[] = [];
  const perDomain = new Map<string, number>();
  for (const { fact } of scored) {
    if (picked.length >= GAP_SLICE_SIZE) break;
    let domain = '';
    try {
      domain = extractDomain(fact.sourceUrl);
    } catch {
      domain = 'unknown';
    }
    const count = perDomain.get(domain) ?? 0;
    if (count >= GAP_MAX_PER_DOMAIN) continue;
    picked.push(fact);
    perDomain.set(domain, count + 1);
  }
  return picked;
}

function tryParseGaps(content: string): Gap[] | null {
  let text = content.trim();
  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence && fence[1]) text = fence[1];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const arr = (parsed as { gaps?: unknown }).gaps;
  if (!Array.isArray(arr)) return null;
  const out: Gap[] = [];
  for (const g of arr) {
    if (!g || typeof g !== 'object') continue;
    const obj = g as Record<string, unknown>;
    if (typeof obj.question !== 'string' || typeof obj.relevance !== 'number') continue;
    out.push({
      question: obj.question.trim(),
      relevance: Math.max(0, Math.min(1, obj.relevance)),
      why: typeof obj.why === 'string' ? obj.why.trim() : '',
    });
  }
  return out;
}

function buildUserMessage(
  task: string,
  contract: ResearchContract | null,
  slice: FactWithEmbedding[],
): string {
  const parts: string[] = [`<task>${task}</task>`];
  if (contract) {
    parts.push(`<core_question>${contract.core_question}</core_question>`);
    if (contract.sub_questions.length > 0) {
      parts.push(`<sub_questions>\n${contract.sub_questions.map((s) => `- ${s}`).join('\n')}\n</sub_questions>`);
    }
    if (contract.good_answer_contains.length > 0) {
      parts.push(
        `<good_answer_contains>\n${contract.good_answer_contains.map((s) => `- ${s}`).join('\n')}\n</good_answer_contains>`,
      );
    }
    if (contract.out_of_scope.length > 0) {
      parts.push(`<out_of_scope>\n${contract.out_of_scope.map((s) => `- ${s}`).join('\n')}\n</out_of_scope>`);
    }
  }
  const factsBlock = slice
    .map((f, i) => `(${i + 1}) [${(() => { try { return extractDomain(f.sourceUrl); } catch { return '?'; } })()}] ${trunc(f.claim, 220)}`)
    .join('\n');
  parts.push(`<facts>\n${factsBlock || '(none)'}\n</facts>`);
  parts.push(`Identify missing angles now. Return JSON.`);
  return parts.join('\n\n');
}

export async function analyzeGaps(
  phaseTransition: string,
  task: string,
  contract: ResearchContract | null,
  allFactsWithEmbeddings: FactWithEmbedding[],
  currentPhase: Phase,
): Promise<{ gapsProposed: number; gapsPushed: number; gapsDeduped: number }> {
  const startedAt = performance.now();

  const taskEmbedding = getTaskEmbedding();
  if (!taskEmbedding) {
    await events.emit({
      kind: 'gap.analyzed',
      layer: 'L4',
      durationMs: Math.round(performance.now() - startedAt),
      payload: {
        phaseTransition,
        gapsProposed: 0,
        gapsPushed: 0,
        gapsDeduped: 0,
        error: 'no cached task embedding on run_state',
      },
    });
    return { gapsProposed: 0, gapsPushed: 0, gapsDeduped: 0 };
  }

  const slice = selectGapSlice(allFactsWithEmbeddings, taskEmbedding);

  const messages: Message[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: buildUserMessage(task, contract, slice) },
  ];

  let parsed: Gap[] | null = null;
  let lastError: string | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await llm.fast(messages, { responseFormat: RESPONSE_FORMAT, maxTokens: 1024 });
      parsed = tryParseGaps(res.content);
      if (parsed && parsed.length > 0) break;
      lastError = parsed
        ? 'zero valid gaps returned'
        : `malformed JSON: ${res.content.slice(0, 120)}`;
    } catch (err) {
      lastError = (err as Error).message;
    }
  }

  const durationMs = Math.round(performance.now() - startedAt);

  if (!parsed || parsed.length === 0) {
    await events.emit({
      kind: 'gap.analyzed',
      layer: 'L4',
      durationMs,
      payload: {
        phaseTransition,
        gapsProposed: 0,
        gapsPushed: 0,
        gapsDeduped: 0,
        error: lastError ?? 'unknown gap analysis failure',
      },
    });
    return { gapsProposed: 0, gapsPushed: 0, gapsDeduped: 0 };
  }

  const gaps = parsed.slice(0, MAX_GAPS);
  const gapEmbeddings = await embedder.embed(gaps.map((g) => g.question));

  let gapsPushed = 0;
  let gapsDeduped = 0;
  const perGap: Array<{
    question: string;
    relevance: number;
    why: string;
    pushed: boolean;
  }> = [];
  for (let i = 0; i < gaps.length; i++) {
    const g = gaps[i]!;
    const embedding = gapEmbeddings[i]!;
    const novelty = computeNovelty(embedding, frontier.allEmbeddings());
    const finalScore = score({ relevance: g.relevance, novelty, depth: 0, phase: currentPhase });
    const id = await frontier.push({
      question: g.question,
      score: finalScore,
      depth: 0,
      embedding,
    });
    const pushed = id !== null;
    if (pushed) gapsPushed++;
    else gapsDeduped++;
    perGap.push({ question: g.question, relevance: g.relevance, why: g.why, pushed });
  }

  await events.emit({
    kind: 'gap.analyzed',
    layer: 'L4',
    durationMs,
    payload: {
      phaseTransition,
      gapsProposed: gaps.length,
      gapsPushed,
      gapsDeduped,
      gaps: perGap,
    },
  });

  return { gapsProposed: gaps.length, gapsPushed, gapsDeduped };
}
