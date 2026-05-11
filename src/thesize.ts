/**
 * Thesis-drafter (L6). At synthesis start, sample a task-relevance-sorted,
 * source-diverse slice of facts and ask the LLM to produce a 3-5 sentence
 * thesis with 4-7 numbered claims (each with a plain-English headline).
 *
 * The output anchors per-claim section writing in synthesize.ts. Claim
 * embeddings are computed here and live in-process for the synthesis phase.
 */

import { llm, type Message } from './llm.ts';
import { embedder } from './embed.ts';
import { events } from './events.ts';
import { extractDomain } from './classify.ts';
import { getTaskEmbedding, type ResearchContract } from './contract.ts';

export type ThesisClaim = {
  claim: string;
  headline: string;
  rationale: string;
  embedding: Float32Array;
};

export type ResearchThesis = {
  thesisSentences: string[];
  claims: ThesisClaim[];
};

type FactWithEmbedding = {
  id: number;
  claim: string;
  sourceUrl: string;
  embedding: Float32Array;
};

const SLICE_SIZE = 60;
const MAX_FACTS_PER_DOMAIN_THESIS = 3;

const SYSTEM_PROMPT = `You are drafting the thesis and claim structure for a research report at synthesis time. The agent has gathered evidence; you decide what the report ARGUES.

OUTPUT FIELDS
- thesis_sentences: 3-5 sentences that, read together, are a real answer to the user's research task. Not a description of the report — the actual claim the report defends. Avoid generic framing like "this report explores...".
- claims: 4-7 entries. Each claim is one specific, defensible assertion that becomes a section of the report. Each entry has:
  - claim: a one-sentence assertion (the section's thesis sentence).
  - headline: 3-8 plain-English words, Title Case, becomes the H2 heading. NOT a slug (no hyphens). Example: "Wage Arbitrage Erosion".
  - rationale: one short line explaining why this claim earns a section.

RULES
- The claims must structure the thesis_sentences. Reading the headlines in order should sketch the argument.
- Rank load-bearing claims first.
- A useful answer often contains: specific mechanisms, named players, quantitative signals, decisions the user could make. Use them.
- Use the <good_answer_contains> guidance when the evidence supports it. Do NOT invent claims for those items if the gathered facts don't support them.
- Use the <out_of_scope> list to avoid claims that drift away from the question.
- Avoid restating the user's question. Avoid duplicate claims.

OUTPUT
Return JSON: {"thesis_sentences": ["...", ...], "claims": [{"claim": "...", "headline": "...", "rationale": "..."}, ...]}.`;

const RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'thesis',
    schema: {
      type: 'object',
      properties: {
        thesis_sentences: { type: 'array', items: { type: 'string' } },
        claims: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              claim: { type: 'string' },
              headline: { type: 'string' },
              rationale: { type: 'string' },
            },
            required: ['claim', 'headline', 'rationale'],
          },
        },
      },
      required: ['thesis_sentences', 'claims'],
    },
  },
} as const;

function dot(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i]! * b[i]!;
  return s;
}

/**
 * Sort all facts by task-cosine descending, then greedily pick respecting the
 * per-domain cap. Stops at SLICE_SIZE.
 */
function selectSlice(
  facts: FactWithEmbedding[],
  taskEmbedding: Float32Array,
): FactWithEmbedding[] {
  const scored = facts.map((f) => ({ fact: f, score: dot(f.embedding, taskEmbedding) }));
  scored.sort((a, b) => b.score - a.score);
  const picked: FactWithEmbedding[] = [];
  const perDomain = new Map<string, number>();
  for (const { fact } of scored) {
    if (picked.length >= SLICE_SIZE) break;
    const domain = (() => {
      try {
        return extractDomain(fact.sourceUrl);
      } catch {
        return 'unknown';
      }
    })();
    const count = perDomain.get(domain) ?? 0;
    if (count >= MAX_FACTS_PER_DOMAIN_THESIS) continue;
    picked.push(fact);
    perDomain.set(domain, count + 1);
  }
  return picked;
}

function trunc(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}

function buildUserMessage(
  task: string,
  contract: ResearchContract | null,
  slice: FactWithEmbedding[],
): string {
  const goodAnswer = contract?.good_answer_contains ?? [];
  const oos = contract?.out_of_scope ?? [];
  const factsBlock = slice
    .map((f, i) => `(${i + 1}) [${extractDomain(f.sourceUrl)}] ${trunc(f.claim, 220)}`)
    .join('\n');
  const parts = [`<research_task>${task}</research_task>`];
  if (goodAnswer.length > 0) {
    parts.push(`<good_answer_contains>\n${goodAnswer.map((s) => `- ${s}`).join('\n')}\n</good_answer_contains>`);
  }
  if (oos.length > 0) {
    parts.push(`<out_of_scope>\n${oos.map((s) => `- ${s}`).join('\n')}\n</out_of_scope>`);
  }
  parts.push(`<facts>\n${factsBlock}\n</facts>`);
  parts.push(`Draft the thesis and claims now.`);
  return parts.join('\n\n');
}

type ParsedThesis = {
  thesisSentences: string[];
  claims: Array<{ claim: string; headline: string; rationale: string }>;
};

function tryParseThesis(content: string): ParsedThesis | null {
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
  const sentencesRaw = obj.thesis_sentences;
  const claimsRaw = obj.claims;
  if (!Array.isArray(sentencesRaw) || !Array.isArray(claimsRaw)) return null;
  const thesisSentences = (sentencesRaw.filter((s) => typeof s === 'string') as string[])
    .map((s) => s.trim())
    .filter(Boolean);
  const claims: Array<{ claim: string; headline: string; rationale: string }> = [];
  for (const c of claimsRaw) {
    if (!c || typeof c !== 'object') continue;
    const co = c as Record<string, unknown>;
    if (typeof co.claim !== 'string' || typeof co.headline !== 'string') continue;
    claims.push({
      claim: co.claim.trim(),
      headline: co.headline.trim(),
      rationale: typeof co.rationale === 'string' ? co.rationale.trim() : '',
    });
  }
  return { thesisSentences, claims };
}

export async function draftThesis(
  task: string,
  contract: ResearchContract | null,
  allFactsWithEmbeddings: FactWithEmbedding[],
): Promise<ResearchThesis | null> {
  const startedAt = performance.now();

  // Use the cached task embedding from run_state (set in S1's runStart). No re-embed.
  const taskEmbedding = getTaskEmbedding();
  if (!taskEmbedding) {
    await events.emit({
      kind: 'thesis.drafted',
      layer: 'L6',
      durationMs: Math.round(performance.now() - startedAt),
      payload: { error: 'no cached task embedding on run_state' },
    });
    return null;
  }

  const slice = selectSlice(allFactsWithEmbeddings, taskEmbedding);
  if (slice.length === 0) {
    await events.emit({
      kind: 'thesis.drafted',
      layer: 'L6',
      durationMs: Math.round(performance.now() - startedAt),
      payload: { error: 'empty slice (no facts)' },
    });
    return null;
  }

  const messages: Message[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: buildUserMessage(task, contract, slice) },
  ];

  let parsed: ParsedThesis | null = null;
  let lastError: string | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await llm.fast(messages, { responseFormat: RESPONSE_FORMAT, maxTokens: 2048 });
      parsed = tryParseThesis(res.content);
      if (parsed) break;
      lastError = `malformed JSON: ${res.content.slice(0, 120)}`;
    } catch (err) {
      lastError = (err as Error).message;
    }
  }

  const durationMs = Math.round(performance.now() - startedAt);

  if (!parsed) {
    await events.emit({
      kind: 'thesis.drafted',
      layer: 'L6',
      durationMs,
      payload: { error: lastError ?? 'unknown thesis drafting failure', factSliceSize: slice.length },
    });
    return null;
  }

  if (parsed.claims.length < 3) {
    await events.emit({
      kind: 'thesis.drafted',
      layer: 'L6',
      durationMs,
      payload: {
        error: `insufficient claims (returned ${parsed.claims.length})`,
        factSliceSize: slice.length,
        claimCount: parsed.claims.length,
      },
    });
    return null;
  }

  // Embed every claim's `claim` string (one batched call).
  const claimEmbeddings = await embedder.embed(parsed.claims.map((c) => c.claim));
  const claimsWithEmbeddings: ThesisClaim[] = parsed.claims.map((c, i) => ({
    claim: c.claim,
    headline: c.headline,
    rationale: c.rationale,
    embedding: claimEmbeddings[i]!,
  }));

  await events.emit({
    kind: 'thesis.drafted',
    layer: 'L6',
    durationMs,
    payload: {
      claimCount: claimsWithEmbeddings.length,
      thesisSentenceCount: parsed.thesisSentences.length,
      factSliceSize: slice.length,
      facts_per_domain_cap: MAX_FACTS_PER_DOMAIN_THESIS,
    },
  });

  return {
    thesisSentences: parsed.thesisSentences,
    claims: claimsWithEmbeddings,
  };
}
