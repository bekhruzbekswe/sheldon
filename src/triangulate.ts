/**
 * Claim-triangulator (L6). Per thesis claim, run two targeted SearXNG queries
 * (corroborate / contradict), scrape top-3 each, ingest into the fact store
 * via the existing relevance-gate / dedupe / classifier path, then score
 * agreement against the claim's embedding to produce {corroborations,
 * contradictions, contested}.
 *
 * Budget-bounded: skips remaining claims with default metadata once the
 * wall-clock budget elapses.
 */

import { searxngClient } from './search.ts';
import { scraper } from './scrape.ts';
import { chunkText } from './chunker.ts';
import { extractor } from './extract.ts';
import { embedder } from './embed.ts';
import { factStore, type FactRow } from './facts.ts';
import { events } from './events.ts';
import type { ThesisClaim } from './thesize.ts';

export type ClaimTriangulation = {
  corroborations: number;
  contradictions: number;
  contested: boolean;
  queriesRan: number;
};

const DISAGREEMENT_MARKERS = [
  'however',
  'but ',
  'contrary',
  'fails to',
  'disputes',
  'criticism',
  'criticized',
  'unlike',
  'nevertheless',
  'whereas',
];

const AGREEMENT_COSINE = 0.55;
const CONTESTED_FRACTION = 0.30;
const CONTESTED_MIN_CONTRADICTIONS = 2;
const TRIANGULATION_TOP_N = 3;
const TRIANGULATION_WINDOW = 200; // chars of rawExcerpt to scan for disagreement markers
// Hard cap per single claim's wall-clock. Originally 60_000; retuned to 180_000 (3 min) after
// v2-tuning's smoke run showed 5 of 6 claims exceeded 60s on a slow-LLM day (per-claim durations
// 153s–504s). 180s catches the realistic median (≈250s on slow days is still over, but most
// claims finish ≤180s on normal days). If real-task usage shows the median routinely exceeds
// 180s, the next tune is per-URL timeout inside `ingestUrl` rather than another constant bump.
const PER_CLAIM_BUDGET_MS = 180_000;

const TRIANGULATION_TOPIC_TAG = 'triangulation';

function dot(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i]! * b[i]!;
  return s;
}

function hasDisagreementMarker(excerpt: string | null): boolean {
  if (!excerpt) return false;
  const lower = excerpt.slice(0, TRIANGULATION_WINDOW).toLowerCase();
  return DISAGREEMENT_MARKERS.some((m) => lower.includes(m));
}

/**
 * Ingest one URL: scrape, chunk, extract, insert. Returns the inserted fact ids
 * for this URL so the caller can score them. Errors are swallowed (per scrape's
 * non-throwing contract).
 */
async function ingestUrl(url: string): Promise<number[]> {
  const inserted: number[] = [];
  const source = await scraper.fetch(url);
  if (!source) return inserted;
  try {
    const chunks = await chunkText(source.text, { sourceUrl: source.url });
    for (const chunk of chunks) {
      const claims = await extractor.extract(chunk.text, {
        question: '', // no parent question for triangulation; the claim itself is the anchor
        sourceUrl: source.url,
        sourceTitle: source.title,
      });
      if (claims.length === 0) continue;
      const embeddings = await embedder.embed(claims.map((c) => c.text));
      for (let i = 0; i < claims.length; i++) {
        const claim = claims[i]!;
        const embedding = embeddings[i]!;
        const id = await factStore.insert({
          claim: claim.text,
          sourceUrl: source.url,
          sourceTitle: source.title || undefined,
          rawExcerpt: chunk.text.slice(0, 800),
          embedding,
          topicTag: TRIANGULATION_TOPIC_TAG,
          confidence: claim.confidence,
        });
        if (id !== null) inserted.push(id);
      }
    }
  } catch (err) {
    console.error(`[triangulate] ingest failed for ${source.url}: ${(err as Error).message}`);
  }
  return inserted;
}

/**
 * After ingestion, walk every fact in the store and score against the claim
 * embedding. Returns {corroborations, contradictions} per the disagreement-marker rule.
 */
function scoreClaim(
  claim: ThesisClaim,
  allFacts: Array<FactRow & { embedding: Float32Array }>,
): { corroborations: number; contradictions: number } {
  let corroborations = 0;
  let contradictions = 0;
  for (const f of allFacts) {
    const sim = dot(f.embedding, claim.embedding);
    if (sim < AGREEMENT_COSINE) continue;
    if (hasDisagreementMarker(f.rawExcerpt)) {
      contradictions++;
    } else {
      corroborations++;
    }
  }
  return { corroborations, contradictions };
}

const CORROBORATE_SUFFIX = ' evidence data report';
const CONTRADICT_SUFFIX = ' dispute criticism limitation';

async function triangulateOne(claim: ThesisClaim): Promise<{
  triangulation: ClaimTriangulation;
  factsAfter: Array<FactRow & { embedding: Float32Array }>;
  budgetExceeded: boolean;
}> {
  const t0 = performance.now();
  const queryCorroborate = `${claim.claim}${CORROBORATE_SUFFIX}`;
  const queryContradict = `${claim.claim}${CONTRADICT_SUFFIX}`;

  const [corResults, conResults] = await Promise.all([
    searxngClient.query(queryCorroborate).catch(() => []),
    searxngClient.query(queryContradict).catch(() => []),
  ]);

  const urls = [
    ...corResults.slice(0, TRIANGULATION_TOP_N).map((r) => r.url),
    ...conResults.slice(0, TRIANGULATION_TOP_N).map((r) => r.url),
  ];

  // Parallel URL ingestion within a single claim. SQLite serializes writes at the
  // driver layer; concurrent dedupe scans may produce occasional near-duplicates,
  // acceptable for triangulation. ~5-10x speedup vs sequential `for…await`.
  await Promise.all(urls.map(ingestUrl));

  // Soft budget check: if the per-claim wall-clock has been exceeded, skip the
  // O(n) corroboration scoring step and return defaults. The ingestion already
  // happened — its facts stay in the corpus and inform synthesis-time retrieval.
  const elapsed = performance.now() - t0;
  if (elapsed > PER_CLAIM_BUDGET_MS) {
    return {
      triangulation: { corroborations: 0, contradictions: 0, contested: false, queriesRan: 2 },
      factsAfter: factStore.listAllWithEmbeddings(),
      budgetExceeded: true,
    };
  }

  const factsAfter = factStore.listAllWithEmbeddings();
  const { corroborations, contradictions } = scoreClaim(claim, factsAfter);
  const total = corroborations + contradictions;
  const contested =
    contradictions >= CONTESTED_MIN_CONTRADICTIONS &&
    total > 0 &&
    contradictions / total >= CONTESTED_FRACTION;

  return {
    triangulation: { corroborations, contradictions, contested, queriesRan: 2 },
    factsAfter,
    budgetExceeded: false,
  };
}

export async function triangulateClaims(claims: ThesisClaim[]): Promise<ClaimTriangulation[]> {
  const out: ClaimTriangulation[] = [];

  for (const claim of claims) {
    const t0 = performance.now();
    try {
      const { triangulation, budgetExceeded } = await triangulateOne(claim);
      out.push(triangulation);
      await events.emit({
        kind: 'claim.triangulated',
        layer: 'L6',
        durationMs: Math.round(performance.now() - t0),
        payload: {
          claimHeadline: claim.headline,
          corroborations: triangulation.corroborations,
          contradictions: triangulation.contradictions,
          contested: triangulation.contested,
          queriesRan: triangulation.queriesRan,
          ...(budgetExceeded ? { error: 'budget exceeded mid-claim' } : {}),
        },
      });
    } catch (err) {
      out.push({ corroborations: 0, contradictions: 0, contested: false, queriesRan: 0 });
      await events.emit({
        kind: 'claim.triangulated',
        layer: 'L6',
        durationMs: Math.round(performance.now() - t0),
        payload: {
          claimHeadline: claim.headline,
          corroborations: 0,
          contradictions: 0,
          contested: false,
          queriesRan: 0,
          error: (err as Error).message,
        },
      });
    }
  }

  return out;
}
