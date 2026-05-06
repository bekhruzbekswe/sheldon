/**
 * K-means clustering over L2-normalized embeddings (cosine ↔ dot).
 *
 * Picks k via silhouette score across [kMin, kMax]. Drops tiny clusters.
 * Labels each cluster: dominant topicTag if >50%, else LLM-generated.
 */

import { llm } from './llm.ts';
import { events } from './events.ts';

export type FactForCluster = {
  id: number;
  embedding: Float32Array;
  topicTag: string | null;
  claim: string;
};

export type Cluster = {
  label: string;
  factIds: number[];
  centroid: Float32Array;
};

export type ClusterOptions = {
  kMin?: number;
  kMax?: number;
  minSize?: number;
  seed?: number;
};

const DEFAULT_K_MIN = 5;
const DEFAULT_K_MAX = 10;
const DEFAULT_MIN_SIZE = 5;
const MAX_ITERATIONS = 50;
const FALLBACK_LABEL = 'misc';

function dot(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i]! * b[i]!;
  return s;
}

function normalize(v: Float32Array): void {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i]! * v[i]!;
  n = Math.sqrt(n);
  if (n > 0) for (let i = 0; i < v.length; i++) v[i] = v[i]! / n;
}

function emptyVec(dim: number): Float32Array {
  return new Float32Array(dim);
}

/** Mulberry32 deterministic PRNG. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** k-means++ init: pick centers proportional to squared distance from nearest existing center. */
function initCenters(
  vectors: Float32Array[],
  k: number,
  rand: () => number,
): Float32Array[] {
  const dim = vectors[0]!.length;
  const centers: Float32Array[] = [];
  const firstIdx = Math.floor(rand() * vectors.length);
  centers.push(new Float32Array(vectors[firstIdx]!));
  while (centers.length < k) {
    const d2 = vectors.map((v) => {
      let nearest = -Infinity;
      for (const c of centers) {
        const sim = dot(v, c);
        if (sim > nearest) nearest = sim;
      }
      // 1 - cos = squared euclidean / 2 for unit vectors
      return Math.max(0, 1 - nearest);
    });
    const sum = d2.reduce((s, x) => s + x, 0);
    if (sum === 0) {
      centers.push(new Float32Array(vectors[Math.floor(rand() * vectors.length)]!));
      continue;
    }
    let r = rand() * sum;
    let pickIdx = 0;
    for (let i = 0; i < d2.length; i++) {
      r -= d2[i]!;
      if (r <= 0) {
        pickIdx = i;
        break;
      }
    }
    centers.push(new Float32Array(vectors[pickIdx]!));
  }
  return centers;
}

function assign(vectors: Float32Array[], centers: Float32Array[]): number[] {
  const labels = new Array<number>(vectors.length);
  for (let i = 0; i < vectors.length; i++) {
    let best = -Infinity;
    let bestC = 0;
    for (let c = 0; c < centers.length; c++) {
      const sim = dot(vectors[i]!, centers[c]!);
      if (sim > best) {
        best = sim;
        bestC = c;
      }
    }
    labels[i] = bestC;
  }
  return labels;
}

function recomputeCenters(vectors: Float32Array[], labels: number[], k: number): Float32Array[] {
  const dim = vectors[0]!.length;
  const sums: Float32Array[] = Array.from({ length: k }, () => emptyVec(dim));
  const counts = new Array<number>(k).fill(0);
  for (let i = 0; i < vectors.length; i++) {
    const lbl = labels[i]!;
    const v = vectors[i]!;
    const s = sums[lbl]!;
    for (let j = 0; j < dim; j++) s[j] = s[j]! + v[j]!;
    counts[lbl]!++;
  }
  for (let c = 0; c < k; c++) {
    if (counts[c]! === 0) {
      // Empty cluster: re-seed with a random vector to avoid collapse.
      const v = vectors[Math.floor(Math.random() * vectors.length)]!;
      sums[c] = new Float32Array(v);
    }
    normalize(sums[c]!);
  }
  return sums;
}

function kmeans(
  vectors: Float32Array[],
  k: number,
  seed: number,
): { labels: number[]; centers: Float32Array[] } {
  const rand = rng(seed);
  let centers = initCenters(vectors, k, rand);
  let labels = assign(vectors, centers);
  for (let it = 0; it < MAX_ITERATIONS; it++) {
    const newCenters = recomputeCenters(vectors, labels, k);
    const newLabels = assign(vectors, newCenters);
    let changed = 0;
    for (let i = 0; i < newLabels.length; i++) {
      if (newLabels[i] !== labels[i]) changed++;
    }
    centers = newCenters;
    labels = newLabels;
    if (changed === 0) break;
  }
  return { labels, centers };
}

/**
 * Silhouette score on cosine distance. Returns mean silhouette ∈ [-1, 1].
 * O(n²) — fine for n ≤ a few thousand.
 */
function silhouette(vectors: Float32Array[], labels: number[]): number {
  const n = vectors.length;
  if (n < 2) return 0;
  const byCluster = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const lbl = labels[i]!;
    if (!byCluster.has(lbl)) byCluster.set(lbl, []);
    byCluster.get(lbl)!.push(i);
  }
  let total = 0;
  for (let i = 0; i < n; i++) {
    const lbl = labels[i]!;
    const own = byCluster.get(lbl)!;
    let aSum = 0;
    let aCount = 0;
    for (const j of own) {
      if (j === i) continue;
      aSum += 1 - dot(vectors[i]!, vectors[j]!);
      aCount++;
    }
    const a = aCount > 0 ? aSum / aCount : 0;

    let b = Infinity;
    for (const [otherLbl, members] of byCluster) {
      if (otherLbl === lbl) continue;
      let s = 0;
      for (const j of members) s += 1 - dot(vectors[i]!, vectors[j]!);
      const meanOther = s / members.length;
      if (meanOther < b) b = meanOther;
    }
    if (!Number.isFinite(b)) b = a;
    const denom = Math.max(a, b);
    total += denom > 0 ? (b - a) / denom : 0;
  }
  return total / n;
}

async function llmLabel(facts: FactForCluster[]): Promise<string> {
  const sample = facts.slice(0, 3).map((f, i) => `(${i + 1}) ${f.claim.slice(0, 200)}`).join('\n');
  const sys =
    'Produce a short, lowercase, hyphen-separated label (≤4 words) summarizing the theme of the following claims. Respond with ONLY the label, no punctuation, no quotes, no explanation.';
  try {
    const res = await llm.fast(
      [
        { role: 'system', content: sys },
        { role: 'user', content: sample },
      ],
      { maxTokens: 32 },
    );
    const cleaned = res.content
      .trim()
      .toLowerCase()
      .replace(/^["'`]+|["'`]+$/g, '')
      .replace(/[^a-z0-9\- ]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60);
    return cleaned || FALLBACK_LABEL;
  } catch {
    return FALLBACK_LABEL;
  }
}

async function labelCluster(facts: FactForCluster[]): Promise<string> {
  // Dominant topic tag (>50%) wins.
  const tagCounts = new Map<string, number>();
  for (const f of facts) {
    if (f.topicTag) tagCounts.set(f.topicTag, (tagCounts.get(f.topicTag) ?? 0) + 1);
  }
  let bestTag: string | null = null;
  let bestCount = 0;
  for (const [tag, c] of tagCounts) {
    if (c > bestCount) {
      bestTag = tag;
      bestCount = c;
    }
  }
  if (bestTag && bestCount > facts.length / 2) return bestTag;

  // Else generate via LLM, falling back to most-common tag or 'misc'.
  const generated = await llmLabel(facts);
  return generated || bestTag || FALLBACK_LABEL;
}

export async function clusterFacts(
  facts: FactForCluster[],
  opts: ClusterOptions = {},
): Promise<Cluster[]> {
  const startedAt = performance.now();
  const kMin = opts.kMin ?? DEFAULT_K_MIN;
  const kMax = opts.kMax ?? DEFAULT_K_MAX;
  const minSize = opts.minSize ?? DEFAULT_MIN_SIZE;
  const seed = opts.seed ?? 42;

  if (facts.length === 0) {
    await events.emit({
      kind: 'cluster.computed',
      layer: 'L6',
      durationMs: Math.round(performance.now() - startedAt),
      payload: { factCount: 0, k: 0, clusterCount: 0, silhouette: 0, sizes: [] },
    });
    return [];
  }

  const vectors = facts.map((f) => f.embedding);
  // For very small N, force k=1 (silhouette is meaningless).
  if (facts.length < Math.max(30, kMin * minSize)) {
    const allIds = facts.map((f) => f.id);
    if (allIds.length < minSize) {
      await events.emit({
        kind: 'cluster.computed',
        layer: 'L6',
        durationMs: Math.round(performance.now() - startedAt),
        payload: { factCount: facts.length, k: 1, clusterCount: 0, silhouette: 0, sizes: [], note: 'below-min-size' },
      });
      return [];
    }
    const dim = vectors[0]!.length;
    const centroid = emptyVec(dim);
    for (const v of vectors) for (let j = 0; j < dim; j++) centroid[j] = centroid[j]! + v[j]!;
    normalize(centroid);
    const label = await labelCluster(facts);
    const cluster: Cluster = { label, factIds: allIds, centroid };
    await events.emit({
      kind: 'cluster.computed',
      layer: 'L6',
      durationMs: Math.round(performance.now() - startedAt),
      payload: {
        factCount: facts.length,
        k: 1,
        clusterCount: 1,
        silhouette: 0,
        sizes: [{ label, size: allIds.length }],
        note: 'small-n-single-cluster',
      },
    });
    return [cluster];
  }

  // Sweep k, keep best by silhouette.
  let bestK = kMin;
  let bestScore = -Infinity;
  let bestRun: { labels: number[]; centers: Float32Array[] } | null = null;
  for (let k = kMin; k <= Math.min(kMax, facts.length); k++) {
    const run = kmeans(vectors, k, seed);
    const score = silhouette(vectors, run.labels);
    if (score > bestScore) {
      bestScore = score;
      bestK = k;
      bestRun = run;
    }
  }
  const { labels, centers } = bestRun!;

  // Group facts by cluster.
  const grouped = new Map<number, FactForCluster[]>();
  for (let i = 0; i < facts.length; i++) {
    const lbl = labels[i]!;
    if (!grouped.has(lbl)) grouped.set(lbl, []);
    grouped.get(lbl)!.push(facts[i]!);
  }

  // Drop tiny ones, label survivors, sort by size desc.
  const surviving: Array<{ idx: number; members: FactForCluster[] }> = [];
  for (const [idx, members] of grouped) {
    if (members.length >= minSize) surviving.push({ idx, members });
  }
  surviving.sort((a, b) => b.members.length - a.members.length);

  const clusters: Cluster[] = [];
  for (const { idx, members } of surviving) {
    const label = await labelCluster(members);
    clusters.push({
      label,
      factIds: members.map((f) => f.id),
      centroid: centers[idx]!,
    });
  }

  await events.emit({
    kind: 'cluster.computed',
    layer: 'L6',
    durationMs: Math.round(performance.now() - startedAt),
    payload: {
      factCount: facts.length,
      k: bestK,
      clusterCount: clusters.length,
      silhouette: Number(bestScore.toFixed(3)),
      sizes: clusters.map((c) => ({ label: c.label, size: c.factIds.length })),
    },
  });

  return clusters;
}
