/**
 * Followup proposer. Given the original task, the question just answered,
 * recent claims, and what's already pending in the frontier, propose 3-5
 * follow-up questions with relevance scores.
 *
 * Uses llm.fast with JSON-schema response_format. Retries once on malformed JSON.
 */

import { llm, type Message } from './llm.ts';

export type Followup = {
  question: string;
  relevance: number;
  why: string;
};

export type ProposeContext = {
  originalTask: string;
  parentQuestion: string;
  /**
   * Task-relevance-sampled, source-diverse fact slice (S3 fresh-bias fix).
   * Replaces the legacy `recentClaims` field. Caller must construct via
   * `factStore.findSimilar(taskEmbedding, ...)` + per-domain cap. Falls back
   * to recency-sorted slice if task embedding is unavailable.
   */
  taskRelevantClaims: string[];
  pendingTitles: string[]; // top-N pending frontier questions
  /**
   * Optional list of currently over-represented domains. When non-empty, the
   * proposer's prompt includes a `<saturated_domains>` block and the system
   * prompt instructs the model to bias toward angles likely to surface
   * different sources. Hint, not hard filter.
   */
  saturatedDomains?: string[];
};

const SYSTEM_PROMPT = `You propose follow-up sub-questions for an autonomous research agent.

RULES
- Read the original research task, the question just answered, the task-relevant claims found, and the questions already pending.
- Propose 3-5 follow-up questions that meaningfully advance the research.
- Each follow-up must be concrete (something a search engine can answer), distinct from anything in the pending list, and grounded in the task-relevant claims.
- If the claims contain nothing new or useful, return an empty list.
- For each follow-up include a relevance score in [0,1] reflecting how central it is to the original task, plus a one-line "why" explanation.
- Do not include meta-questions ("what should we research next?"). Substance only.
- If a <saturated_domains> block is present, the corpus is already over-represented by those domains. Bias your proposed questions toward angles likely to surface DIFFERENT sources (e.g., named industry players, regulators, academic studies, named analyst firms — whatever fits the task). Don't reject saturated domains entirely; just don't disproportionately produce questions that would obviously return more from the same domain.

OUTPUT
Return JSON: {"followups": [{"question": "...", "relevance": 0.X, "why": "..."}, ...]}.`;

const RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'followups',
    schema: {
      type: 'object',
      properties: {
        followups: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              question: { type: 'string' },
              relevance: { type: 'number' },
              why: { type: 'string' },
            },
            required: ['question', 'relevance'],
          },
        },
      },
      required: ['followups'],
    },
  },
} as const;

function trunc(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}

function buildUserMessage(ctx: ProposeContext): string {
  const claims = ctx.taskRelevantClaims
    .slice(0, 10)
    .map((c, i) => `(${i + 1}) ${trunc(c, 200)}`)
    .join('\n');
  const pending = ctx.pendingTitles
    .slice(0, 5)
    .map((q, i) => `(${i + 1}) ${trunc(q, 120)}`)
    .join('\n');
  const parts = [
    `<original_task>${ctx.originalTask}</original_task>`,
    `<parent_question>${ctx.parentQuestion}</parent_question>`,
    `<task_relevant_claims>\n${claims || '(none)'}\n</task_relevant_claims>`,
    `<pending_frontier>\n${pending || '(empty)'}\n</pending_frontier>`,
  ];
  if (ctx.saturatedDomains && ctx.saturatedDomains.length > 0) {
    parts.push(
      `<saturated_domains>\n${ctx.saturatedDomains.map((d) => `- ${d}`).join('\n')}\n</saturated_domains>`,
    );
  }
  parts.push(`Propose 3-5 distinct follow-ups now.`);
  return parts.join('\n\n');
}

function tryParseFollowups(content: string): Followup[] | null {
  let text = content.trim();
  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence && fence[1]) text = fence[1];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const arr = (parsed as { followups?: unknown })?.followups;
  if (!Array.isArray(arr)) return null;
  const out: Followup[] = [];
  for (const f of arr) {
    if (!f || typeof f !== 'object') continue;
    const obj = f as Record<string, unknown>;
    if (typeof obj.question !== 'string' || typeof obj.relevance !== 'number') continue;
    out.push({
      question: obj.question.trim(),
      relevance: Math.max(0, Math.min(1, obj.relevance)),
      why: typeof obj.why === 'string' ? obj.why.trim() : '',
    });
  }
  return out;
}

export const proposer = {
  async propose(ctx: ProposeContext): Promise<Followup[]> {
    const messages: Message[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildUserMessage(ctx) },
    ];

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await llm.fast(messages, { responseFormat: RESPONSE_FORMAT, maxTokens: 1024 });
        const parsed = tryParseFollowups(res.content);
        if (parsed) return parsed;
      } catch {
        // fall through to retry
      }
    }
    return [];
  },
};
