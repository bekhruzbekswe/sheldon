/**
 * Persistent fact store. Insert with auto-dedupe at cosine ≥ 0.95;
 * findSimilar with brute-force cosine; list with simple filters.
 *
 * Embeddings are stored as raw Float32 BLOBs (little-endian).
 */

import { getDb } from './db.ts';
import { events } from './events.ts';
import { getTaskEmbedding, getOutOfScopeEmbeddings } from './contract.ts';

export type FactInput = {
  claim: string;
  sourceUrl: string;
  sourceTitle?: string;
  rawExcerpt?: string;
  embedding: Float32Array;
  topicTag?: string;
  confidence?: number;
  questionId?: number;
};

export type FactRow = {
  id: number;
  claim: string;
  sourceUrl: string;
  sourceTitle: string | null;
  rawExcerpt: string | null;
  embedding?: Float32Array;
  topicTag: string | null;
  confidence: number | null;
  questionId: number | null;
  createdAt: number;
};

export type SimilarFact = FactRow & { similarity: number };

const DEDUPE_THRESHOLD = 0.95;
// Empirically tuned from first-run telemetry: at T_DROP=0.05 the gate rejected 94% of
// extracted claims because LLM-drafted out-of-scope items overlap heavily with legitimate
// adjacent content (taskSim and maxOosSim both naturally land in 0.2-0.5 for MiniLM-L6).
// Score distribution showed p25≈-0.10, p50≈-0.04, p90≈+0.03; -0.10 keeps clearly off-topic
// content rejected (min observed -0.47) while admitting useful adjacent material.
const T_DROP = -0.10;

function floatArrToBuf(arr: Float32Array): Buffer {
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}

function bufToFloatArr(buf: Buffer | Uint8Array): Float32Array {
  // Build a clean Float32Array; the buffer's byteOffset may not be 4-aligned.
  const out = new Float32Array(buf.byteLength / 4);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  for (let i = 0; i < out.length; i++) {
    out[i] = view.getFloat32(i * 4, true);
  }
  return out;
}

function cosine(a: Float32Array, b: Float32Array): number {
  // Both inputs must be L2-normalized (the embedder guarantees this), so cosine = dot.
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i]! * b[i]!;
  return s;
}

type RawRow = {
  id: number;
  claim: string;
  source_url: string;
  source_title: string | null;
  raw_excerpt: string | null;
  embedding?: Buffer | Uint8Array;
  topic_tag: string | null;
  confidence: number | null;
  question_id: number | null;
  created_at: number;
};

function rowToFact(r: RawRow, includeEmbedding = false): FactRow {
  const out: FactRow = {
    id: r.id,
    claim: r.claim,
    sourceUrl: r.source_url,
    sourceTitle: r.source_title,
    rawExcerpt: r.raw_excerpt,
    topicTag: r.topic_tag,
    confidence: r.confidence,
    questionId: r.question_id,
    createdAt: r.created_at,
  };
  if (includeEmbedding && r.embedding) {
    out.embedding = bufToFloatArr(r.embedding);
  }
  return out;
}

export const factStore = {
  async insert(input: FactInput): Promise<number | null> {
    const db = getDb();

    // Relevance gate: drop facts whose claim embedding is far from the run's task,
    // or close to one of the contract's out-of-scope items. Runs BEFORE the dedupe
    // scan to avoid wasting an O(n) sweep on facts we'd drop anyway.
    const taskEmb = getTaskEmbedding();
    if (taskEmb) {
      const taskSim = cosine(input.embedding, taskEmb);
      const oosEmbeddings = await getOutOfScopeEmbeddings();
      let maxOosSim = 0;
      for (const oos of oosEmbeddings) {
        const s = cosine(input.embedding, oos);
        if (s > maxOosSim) maxOosSim = s;
      }
      const score = taskSim - maxOosSim;
      if (score < T_DROP) {
        await events.emit({
          kind: 'fact.dropped.irrelevant',
          layer: 'L3',
          payload: {
            claim: input.claim.slice(0, 80),
            sourceUrl: input.sourceUrl,
            taskSimilarity: Number(taskSim.toFixed(4)),
            maxOosSimilarity: Number(maxOosSim.toFixed(4)),
            score: Number(score.toFixed(4)),
            threshold: T_DROP,
          },
        });
        return null;
      }
    }

    // Dedupe check: brute-force cosine against existing rows.
    const existingRows = db
      .query('SELECT id, embedding FROM facts')
      .all() as Array<{ id: number; embedding: Buffer | Uint8Array }>;
    for (const row of existingRows) {
      const e = bufToFloatArr(row.embedding);
      const sim = cosine(e, input.embedding);
      if (sim >= DEDUPE_THRESHOLD) {
        await events.emit({
          kind: 'fact.dedupe',
          layer: 'L3',
          payload: {
            matchedId: row.id,
            similarity: Number(sim.toFixed(4)),
            claim: input.claim.slice(0, 80),
          },
        });
        return null;
      }
    }

    const stmt = db.prepare(`
      INSERT INTO facts (claim, source_url, source_title, raw_excerpt, embedding, topic_tag, confidence, question_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      input.claim,
      input.sourceUrl,
      input.sourceTitle ?? null,
      input.rawExcerpt ?? null,
      floatArrToBuf(input.embedding),
      input.topicTag ?? null,
      input.confidence ?? null,
      input.questionId ?? null,
      Date.now(),
    );
    const id = Number(result.lastInsertRowid);

    await events.emit({
      kind: 'fact.write',
      layer: 'L3',
      payload: {
        id,
        claim: input.claim.slice(0, 80),
        sourceUrl: input.sourceUrl,
        topicTag: input.topicTag ?? null,
        confidence: input.confidence ?? null,
      },
    });

    return id;
  },

  findSimilar(
    queryEmbedding: Float32Array,
    opts: { topK?: number; minSim?: number } = {},
  ): SimilarFact[] {
    const db = getDb();
    const topK = opts.topK ?? 10;
    const minSim = opts.minSim ?? 0.5;

    const rows = db.query('SELECT * FROM facts').all() as RawRow[];
    const scored: SimilarFact[] = [];
    for (const r of rows) {
      const e = bufToFloatArr(r.embedding!);
      const sim = cosine(e, queryEmbedding);
      if (sim >= minSim) {
        scored.push({ ...rowToFact(r), similarity: sim });
      }
    }
    scored.sort((a, b) => b.similarity - a.similarity);
    return scored.slice(0, topK);
  },

  list(opts: { limit?: number; sourceUrl?: string; topicTag?: string } = {}): FactRow[] {
    const db = getDb();
    const limit = opts.limit ?? 50;
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (opts.sourceUrl) {
      where.push('source_url = ?');
      params.push(opts.sourceUrl);
    }
    if (opts.topicTag) {
      where.push('topic_tag = ?');
      params.push(opts.topicTag);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const sql = `SELECT id, claim, source_url, source_title, raw_excerpt, topic_tag, confidence, question_id, created_at
                 FROM facts ${whereSql} ORDER BY created_at DESC LIMIT ?`;
    params.push(limit);
    const rows = db.query(sql).all(...params) as RawRow[];
    return rows.map((r) => rowToFact(r, false));
  },

  count(): number {
    return (getDb().query('SELECT COUNT(*) AS n FROM facts').get() as { n: number }).n;
  },

  /**
   * Read every fact with its embedding. Used by L6 synthesis to cluster.
   */
  listAllWithEmbeddings(): Array<FactRow & { embedding: Float32Array }> {
    const db = getDb();
    const rows = db.query('SELECT * FROM facts ORDER BY id ASC').all() as RawRow[];
    return rows.map((r) => {
      const fact = rowToFact(r, true);
      return fact as FactRow & { embedding: Float32Array };
    });
  },
};
