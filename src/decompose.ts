/**
 * Question decomposer. Turns a user research task into seed sub-questions.
 *
 * Output: array of {question, topicTag, score} where score ∈ [0.5, 0.9].
 * Uses llm.fast with JSON-schema response_format. One retry on malformed JSON.
 */

import { llm, type Message } from './llm.ts';
import { events } from './events.ts';

export type Seed = {
  question: string;
  topicTag: string;
  score: number;
};

export type DecomposeOptions = {
  count?: number;
};

const DEFAULT_COUNT = 12;

const SYSTEM_PROMPT = `You decompose a research task into well-scoped sub-questions.

RULES
- Produce {count} sub-questions covering breadth-first angles of the task.
- Each sub-question must be specific enough to search the open web for, but not so narrow that one article answers it. Avoid yes/no questions.
- Each must come with a short topicTag (lowercase, hyphenated, ≤4 words) and a score in [0.5, 0.9] reflecting how likely that question is to yield productive findings (higher = more central to the task).
- Avoid near-duplicates. Cover distinct angles.
- Do not write meta-questions like "What sources should I read?" — focus on substance.

OUTPUT
Return JSON: {"seeds": [{"question": "...", "topicTag": "...", "score": 0.X}, ...]}.`;

const RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'seeds',
    schema: {
      type: 'object',
      properties: {
        seeds: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              question: { type: 'string' },
              topicTag: { type: 'string' },
              score: { type: 'number' },
            },
            required: ['question', 'topicTag', 'score'],
          },
        },
      },
      required: ['seeds'],
    },
  },
} as const;

function tryParseSeeds(content: string): Seed[] | null {
  let text = content.trim();
  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence && fence[1]) text = fence[1];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const seedsRaw = (parsed as { seeds?: unknown })?.seeds;
  if (!Array.isArray(seedsRaw)) return null;
  const out: Seed[] = [];
  for (const s of seedsRaw) {
    if (!s || typeof s !== 'object') continue;
    const obj = s as Record<string, unknown>;
    if (
      typeof obj.question !== 'string' ||
      typeof obj.topicTag !== 'string' ||
      typeof obj.score !== 'number'
    )
      continue;
    out.push({
      question: obj.question.trim(),
      topicTag: obj.topicTag.trim(),
      score: Math.max(0.5, Math.min(0.9, obj.score)),
    });
  }
  return out;
}

export const decomposer = {
  async decompose(task: string, opts: DecomposeOptions = {}): Promise<Seed[]> {
    const count = opts.count ?? DEFAULT_COUNT;
    const messages: Message[] = [
      { role: 'system', content: SYSTEM_PROMPT.replace('{count}', String(count)) },
      {
        role: 'user',
        content: `<research_task>${task}</research_task>\n\nProduce ${count} seed sub-questions now.`,
      },
    ];

    const startedAt = performance.now();
    let seeds: Seed[] | null = null;
    let lastError: string | null = null;

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await llm.fast(messages, { responseFormat: RESPONSE_FORMAT, maxTokens: 2048 });
        seeds = tryParseSeeds(res.content);
        if (seeds && seeds.length > 0) break;
        lastError = `malformed or empty seeds JSON: ${res.content.slice(0, 120)}`;
      } catch (err) {
        lastError = (err as Error).message;
      }
    }

    const durationMs = Math.round(performance.now() - startedAt);

    if (!seeds || seeds.length === 0) {
      await events.emit({
        kind: 'frontier.seed',
        layer: 'L4',
        durationMs,
        payload: {
          task: task.slice(0, 80),
          seedCount: 0,
          error: lastError ?? 'unknown decomposition failure',
        },
      });
      return [];
    }

    const avgScore = seeds.reduce((s, q) => s + q.score, 0) / seeds.length;
    await events.emit({
      kind: 'frontier.seed',
      layer: 'L4',
      durationMs,
      payload: {
        task: task.slice(0, 80),
        seedCount: seeds.length,
        avgScore: Number(avgScore.toFixed(3)),
      },
    });

    return seeds;
  },
};
