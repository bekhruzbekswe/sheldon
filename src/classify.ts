/**
 * Per-domain source classifier. On first encounter of a domain, ask the LLM
 * to label its source_type / promotional_intent / primary_vs_derivative.
 * Persisted forever in the `sources` table; survives `--fresh` (clearAll only
 * deletes run-scoped tables, not this cache).
 */

import { llm, type Message } from './llm.ts';
import { events } from './events.ts';
import { getDb } from './db.ts';

export type SourceType =
  | 'academic'
  | 'regulator'
  | 'analyst'
  | 'vc-blog'
  | 'trade-pub'
  | 'vendor'
  | 'personal-blog'
  | 'forum'
  | 'other';

export type PromotionalIntent = 'none' | 'low' | 'medium' | 'high';
export type PrimaryVsDerivative = 'primary' | 'derivative' | 'mixed';

export type SourceClassification = {
  sourceType: SourceType;
  promotionalIntent: PromotionalIntent;
  primaryVsDerivative: PrimaryVsDerivative;
};

const SOURCE_TYPES: readonly SourceType[] = [
  'academic',
  'regulator',
  'analyst',
  'vc-blog',
  'trade-pub',
  'vendor',
  'personal-blog',
  'forum',
  'other',
] as const;
const PROMO_INTENTS: readonly PromotionalIntent[] = ['none', 'low', 'medium', 'high'] as const;
const PRIM_DERIV: readonly PrimaryVsDerivative[] = ['primary', 'derivative', 'mixed'] as const;

const SAMPLE_TEXT_CAP = 3000;

const DEFAULT_CLASSIFICATION: SourceClassification = {
  sourceType: 'other',
  promotionalIntent: 'medium',
  primaryVsDerivative: 'mixed',
};

const SYSTEM_PROMPT = `You classify a web source by *type* and *intent* from a sample of its text.

OUTPUT FIELDS
- source_type: one of "academic", "regulator", "analyst" (recognized industry analyst e.g. Gartner, Forrester, IDC), "vc-blog" (e.g. a16z, Sequoia, Bessemer), "trade-pub" (sector trade publication), "vendor" (a company writing about its own product or industry), "personal-blog", "forum" (Q&A or community thread), or "other".
- promotional_intent: how strongly the source has commercial interest in the framing of the topic. "none" = neutral reporting; "low" = informational with mild brand presence; "medium" = bylined by a vendor employee or thinly-veiled marketing; "high" = explicit sales or product page.
- primary_vs_derivative: "primary" if the source produced the underlying analysis or data; "derivative" if it summarises / cites others; "mixed" if both.

OUTPUT
Return JSON: {"source_type":"...","promotional_intent":"...","primary_vs_derivative":"..."}.`;

const RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'source_classification',
    schema: {
      type: 'object',
      properties: {
        source_type: { type: 'string', enum: SOURCE_TYPES },
        promotional_intent: { type: 'string', enum: PROMO_INTENTS },
        primary_vs_derivative: { type: 'string', enum: PRIM_DERIV },
      },
      required: ['source_type', 'promotional_intent', 'primary_vs_derivative'],
    },
  },
} as const;

export function extractDomain(url: string): string {
  const host = new URL(url).hostname.toLowerCase();
  return host.startsWith('www.') ? host.slice(4) : host;
}

type RawRow = {
  domain: string;
  source_type: string | null;
  promotional_intent: string | null;
  primary_vs_derivative: string | null;
  classified_at: number | null;
  raw_label_json: string | null;
};

function rowToClassification(row: RawRow): SourceClassification {
  return {
    sourceType: (row.source_type as SourceType | null) ?? DEFAULT_CLASSIFICATION.sourceType,
    promotionalIntent:
      (row.promotional_intent as PromotionalIntent | null) ?? DEFAULT_CLASSIFICATION.promotionalIntent,
    primaryVsDerivative:
      (row.primary_vs_derivative as PrimaryVsDerivative | null) ?? DEFAULT_CLASSIFICATION.primaryVsDerivative,
  };
}

export function lookupSource(domain: string): SourceClassification | null {
  const row = getDb().query('SELECT * FROM sources WHERE domain = ?').get(domain) as RawRow | null;
  if (!row) return null;
  return rowToClassification(row);
}

function tryParseClassification(content: string): SourceClassification | null {
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
  const st = obj.source_type;
  const pi = obj.promotional_intent;
  const pd = obj.primary_vs_derivative;
  if (typeof st !== 'string' || !SOURCE_TYPES.includes(st as SourceType)) return null;
  if (typeof pi !== 'string' || !PROMO_INTENTS.includes(pi as PromotionalIntent)) return null;
  if (typeof pd !== 'string' || !PRIM_DERIV.includes(pd as PrimaryVsDerivative)) return null;
  return {
    sourceType: st as SourceType,
    promotionalIntent: pi as PromotionalIntent,
    primaryVsDerivative: pd as PrimaryVsDerivative,
  };
}

export async function classifySource(
  domain: string,
  sampleText: string,
): Promise<SourceClassification> {
  const sample = sampleText.slice(0, SAMPLE_TEXT_CAP);
  const messages: Message[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: `<domain>${domain}</domain>\n<sample>\n${sample}\n</sample>\n\nClassify this source now.`,
    },
  ];

  const startedAt = performance.now();
  let result: SourceClassification | null = null;
  let rawJson: string | null = null;
  let lastError: string | null = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await llm.fast(messages, { responseFormat: RESPONSE_FORMAT, maxTokens: 256 });
      const parsed = tryParseClassification(res.content);
      if (parsed) {
        result = parsed;
        rawJson = res.content.trim();
        break;
      }
      lastError = `malformed JSON or out-of-enum: ${res.content.slice(0, 120)}`;
    } catch (err) {
      lastError = (err as Error).message;
    }
  }

  const durationMs = Math.round(performance.now() - startedAt);
  const final = result ?? DEFAULT_CLASSIFICATION;

  // Persist on success or failure (caches the failure too — prevents retry storms on broken-classifier domains).
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO sources
         (domain, source_type, promotional_intent, primary_vs_derivative, classified_at, raw_label_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      domain,
      final.sourceType,
      final.promotionalIntent,
      final.primaryVsDerivative,
      Date.now(),
      result ? rawJson : null,
    );

  await events.emit({
    kind: 'source.classified',
    layer: 'L3',
    durationMs,
    payload: {
      domain,
      sourceType: final.sourceType,
      promotionalIntent: final.promotionalIntent,
      primaryVsDerivative: final.primaryVsDerivative,
      ...(result ? {} : { error: lastError ?? 'unknown classification failure' }),
    },
  });

  return final;
}
