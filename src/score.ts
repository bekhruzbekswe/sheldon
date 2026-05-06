/**
 * Pure scoring helpers.
 *
 * Phase-aware:
 *   breadth:    0.4*r + 0.5*n + 0.1 * (0.7 ** depth)
 *   depth:      0.5*r + 0.15*n + 0.35 * min(1.5, 1.0 + 0.05*depth)
 *   synthesis:  0   (search is locked, score is meaningless)
 *
 * `novelty = 1 - max cosine to any existing frontier embedding` (1 if empty).
 * Inputs are L2-normalized so cosine reduces to dot product.
 */

import type { Phase } from './phase.ts';

export type ScoreInput = {
  relevance: number;
  novelty: number;
  depth: number;
  phase?: Phase;
};

export function score(input: ScoreInput): number {
  const phase = input.phase ?? 'breadth';
  if (phase === 'synthesis') return 0;
  const r = clamp01(input.relevance);
  const n = clamp01(input.novelty);
  const d = Math.max(0, Math.floor(input.depth));
  if (phase === 'breadth') {
    return 0.4 * r + 0.5 * n + 0.1 * Math.pow(0.7, d);
  }
  // depth
  const depthBonus = Math.min(1.5, 1.0 + 0.05 * d);
  return 0.5 * r + 0.15 * n + 0.35 * depthBonus;
}

export function computeNovelty(candidate: Float32Array, existing: Float32Array[]): number {
  if (existing.length === 0) return 1;
  let max = -Infinity;
  for (const e of existing) {
    const len = Math.min(candidate.length, e.length);
    let s = 0;
    for (let i = 0; i < len; i++) s += candidate[i]! * e[i]!;
    if (s > max) max = s;
  }
  return Math.max(0, 1 - Math.min(1, max));
}

function clamp01(x: number): number {
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}
