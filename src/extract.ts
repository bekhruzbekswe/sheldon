/**
 * Atomic-claim extractor. Takes a chunk of text and the original question,
 * asks the LLM (fast mode) to return a JSON list of claims with confidence
 * and topic tags. Retries once on malformed JSON; returns [] on persistent failure.
 */

import { llm, type Message } from './llm.ts';
import { events } from './events.ts';

export type Claim = {
  text: string;
  confidence: number;
  topicTag?: string;
};

export type ExtractContext = {
  question: string;
  sourceUrl: string;
  sourceTitle?: string;
};

const SYSTEM_PROMPT = `You extract atomic factual claims from a single text excerpt.

RULES
- Each claim is a single, self-contained sentence that can be verified against the excerpt alone.
- Preserve specific numbers, dates, names, and proper nouns verbatim.
- Do NOT paraphrase opinions as facts. If a source says "X claims Y", the claim is "X claims Y" — not "Y is true".
- Do NOT invent anything not in the excerpt. If the excerpt has nothing relevant to the user's question, return zero claims.
- Set confidence in [0, 1]: 1.0 = excerpt directly states this; 0.5 = strongly implied; 0.2 = weakly suggested.
- Set topicTag to a short freeform label (e.g. "regulation", "energy-cost", "labor-impact"). Lowercase, hyphen-separated, ≤4 words.

OUTPUT
Return a JSON object: {"claims": [{"text": "...", "confidence": 0.X, "topicTag": "..."}]}.
At most 12 claims per excerpt. Pick the most informative ones if more would qualify.`;

const RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'claims',
    schema: {
      type: 'object',
      properties: {
        claims: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              text: { type: 'string' },
              confidence: { type: 'number' },
              topicTag: { type: 'string' },
            },
            required: ['text', 'confidence'],
          },
        },
      },
      required: ['claims'],
    },
  },
} as const;

function buildUserMessage(chunk: string, ctx: ExtractContext): string {
  return [
    `<user_question>${ctx.question}</user_question>`,
    `<source url=${JSON.stringify(ctx.sourceUrl)} title=${JSON.stringify(ctx.sourceTitle ?? '')}>`,
    chunk,
    `</source>`,
    `Extract atomic claims relevant to the user question. Return JSON now.`,
  ].join('\n\n');
}

function tryParseClaims(content: string): Claim[] | null {
  let text = content.trim();
  // Strip Markdown code fence if present.
  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence && fence[1]) text = fence[1];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const claimsRaw = (parsed as { claims?: unknown }).claims;
  if (!Array.isArray(claimsRaw)) return null;

  const out: Claim[] = [];
  for (const c of claimsRaw) {
    if (!c || typeof c !== 'object') continue;
    const obj = c as Record<string, unknown>;
    const t = obj.text;
    const conf = obj.confidence;
    if (typeof t !== 'string' || typeof conf !== 'number') continue;
    const claim: Claim = {
      text: t.trim(),
      confidence: Math.max(0, Math.min(1, conf)),
    };
    if (typeof obj.topicTag === 'string') claim.topicTag = obj.topicTag.trim();
    if (claim.text.length > 0) out.push(claim);
  }
  return out;
}

export const extractor = {
  async extract(chunk: string, ctx: ExtractContext): Promise<Claim[]> {
    const messages: Message[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildUserMessage(chunk, ctx) },
    ];

    const startedAt = performance.now();
    let claims: Claim[] | null = null;
    let lastError: string | null = null;

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await llm.fast(messages, { responseFormat: RESPONSE_FORMAT, maxTokens: 1024 });
        claims = tryParseClaims(res.content);
        if (claims) break;
        lastError = `malformed JSON: ${res.content.slice(0, 120)}`;
      } catch (err) {
        lastError = (err as Error).message;
      }
    }

    const durationMs = Math.round(performance.now() - startedAt);

    if (!claims) {
      await events.emit({
        kind: 'claim.extract',
        layer: 'L3',
        durationMs,
        payload: {
          sourceUrl: ctx.sourceUrl,
          claimCount: 0,
          error: lastError ?? 'unknown extraction failure',
        },
      });
      return [];
    }

    const avgConfidence =
      claims.length > 0 ? claims.reduce((s, c) => s + c.confidence, 0) / claims.length : 0;

    await events.emit({
      kind: 'claim.extract',
      layer: 'L3',
      durationMs,
      payload: {
        sourceUrl: ctx.sourceUrl,
        claimCount: claims.length,
        avgConfidence: Number(avgConfidence.toFixed(3)),
      },
    });

    return claims;
  },
};
