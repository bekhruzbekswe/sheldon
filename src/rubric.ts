/**
 * Section rubric (L6). One llm.fast call per drafted section, returning a
 * small structured evaluation that drives the brutal-editor pass.
 *
 * Fails open: if the rubric LLM call fails, return all-pass so legitimate
 * sections are not deleted by a flaky rubric.
 */

import { llm, type Message } from './llm.ts';
import { events } from './events.ts';
import type { ThesisClaim } from './thesize.ts';

export type SectionRubric = {
  hasMechanism: boolean;
  hasExample: boolean;
  hasQuantification: boolean;
  defendsHeading: boolean;
  note: string;
};

const PASS_BY_DEFAULT: SectionRubric = {
  hasMechanism: true,
  hasExample: true,
  hasQuantification: true,
  defendsHeading: true,
  note: 'rubric LLM failed; pass-by-default',
};

const SYSTEM_PROMPT = `You evaluate a section of a research report against a small structural rubric.

INPUT
- The section's headline (the H2 it appears under).
- The section's claim (the one-sentence thesis the body is supposed to defend).
- The section's body (Markdown prose).

OUTPUT FIELDS (all required)
- has_mechanism: boolean — does the body explain HOW something happens (a causal mechanism), not just list facts?
- has_example: boolean — is there at least one concrete example: named company, person, study, case, or specific situation?
- has_quantification: boolean — at least one quantitative signal (%, $, n=N, a year, a count)?
- defends_heading: boolean — does the body actually defend the headline's claim, or does it drift into adjacent material?
- note: string — required when ANY field is false. One short line explaining the most important shortfall (used as feedback for revision). May be empty when all four are true.

Be strict. A section that is competent prose but doesn't earn its heading should fail "defends_heading". A section that asserts a trend without a mechanism, or without any concrete example, should fail those fields.

OUTPUT
Return JSON: {"has_mechanism": true|false, "has_example": true|false, "has_quantification": true|false, "defends_heading": true|false, "note": "..."}.`;

const RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'section_rubric',
    schema: {
      type: 'object',
      properties: {
        has_mechanism: { type: 'boolean' },
        has_example: { type: 'boolean' },
        has_quantification: { type: 'boolean' },
        defends_heading: { type: 'boolean' },
        note: { type: 'string' },
      },
      required: ['has_mechanism', 'has_example', 'has_quantification', 'defends_heading', 'note'],
    },
  },
} as const;

function tryParseRubric(content: string): SectionRubric | null {
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
  const obj = parsed as Record<string, unknown>;
  if (
    typeof obj.has_mechanism !== 'boolean' ||
    typeof obj.has_example !== 'boolean' ||
    typeof obj.has_quantification !== 'boolean' ||
    typeof obj.defends_heading !== 'boolean'
  )
    return null;
  return {
    hasMechanism: obj.has_mechanism,
    hasExample: obj.has_example,
    hasQuantification: obj.has_quantification,
    defendsHeading: obj.defends_heading,
    note: typeof obj.note === 'string' ? obj.note.trim() : '',
  };
}

export async function evaluateSection(body: string, claim: ThesisClaim): Promise<SectionRubric> {
  const startedAt = performance.now();
  const userMessage = [
    `<headline>${claim.headline}</headline>`,
    `<claim>${claim.claim}</claim>`,
    `<body>\n${body}\n</body>`,
    `Evaluate this section now.`,
  ].join('\n\n');
  const messages: Message[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userMessage },
  ];

  let result: SectionRubric | null = null;
  let lastError: string | null = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await llm.fast(messages, { responseFormat: RESPONSE_FORMAT, maxTokens: 256 });
      result = tryParseRubric(res.content);
      if (result) break;
      lastError = `malformed JSON: ${res.content.slice(0, 120)}`;
    } catch (err) {
      lastError = (err as Error).message;
    }
  }

  const durationMs = Math.round(performance.now() - startedAt);

  if (!result) {
    await events.emit({
      kind: 'section.rubric',
      layer: 'L6',
      durationMs,
      payload: {
        headline: claim.headline,
        ...PASS_BY_DEFAULT,
        error: lastError ?? 'unknown rubric failure',
      },
    });
    return PASS_BY_DEFAULT;
  }

  await events.emit({
    kind: 'section.rubric',
    layer: 'L6',
    durationMs,
    payload: {
      headline: claim.headline,
      hasMechanism: result.hasMechanism,
      hasExample: result.hasExample,
      hasQuantification: result.hasQuantification,
      defendsHeading: result.defendsHeading,
    },
  });

  return result;
}
