/**
 * Frontier queue. SQLite-backed priority queue with novelty-aware push.
 *
 * Push compares the candidate's embedding against every existing entry's
 * embedding (regardless of status). Cosine ≥ 0.85 means "we already know
 * about this thread" — skip and emit `frontier.dedupe`.
 *
 * Pop is a single transaction so future parallelism (and L7 resume) can rely
 * on the in-progress marker.
 */

import { getDb } from './db.ts';
import { events } from './events.ts';
import { getRunState, phaseMachine } from './phase.ts';

export type FrontierStatus = 'pending' | 'in-progress' | 'done' | 'skipped';

export type FrontierRow = {
  id: number;
  question: string;
  score: number;
  status: FrontierStatus;
  parentId: number | null;
  depth: number;
  embedding?: Float32Array;
  createdAt: number;
  processedAt: number | null;
};

export type PushInput = {
  question: string;
  score: number;
  parentId?: number;
  depth: number;
  embedding: Float32Array;
};

export type DoneOutcome = {
  factsAdded: number;
  claimsExtracted: number;
};

const DEDUPE_THRESHOLD = 0.85;

function floatArrToBuf(arr: Float32Array): Buffer {
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}

function bufToFloatArr(buf: Buffer | Uint8Array): Float32Array {
  const out = new Float32Array(buf.byteLength / 4);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  for (let i = 0; i < out.length; i++) out[i] = view.getFloat32(i * 4, true);
  return out;
}

function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i]! * b[i]!;
  return s;
}

type RawRow = {
  id: number;
  question: string;
  score: number;
  status: FrontierStatus;
  parent_id: number | null;
  depth: number;
  embedding?: Buffer | Uint8Array;
  created_at: number;
  processed_at: number | null;
};

function rowToFrontier(r: RawRow, includeEmbedding = false): FrontierRow {
  const out: FrontierRow = {
    id: r.id,
    question: r.question,
    score: r.score,
    status: r.status,
    parentId: r.parent_id,
    depth: r.depth,
    createdAt: r.created_at,
    processedAt: r.processed_at,
  };
  if (includeEmbedding && r.embedding) out.embedding = bufToFloatArr(r.embedding);
  return out;
}

export const frontier = {
  async push(input: PushInput): Promise<number | null> {
    const db = getDb();
    const existing = db
      .query('SELECT id, embedding FROM frontier')
      .all() as Array<{ id: number; embedding: Buffer | Uint8Array }>;

    let bestId = -1;
    let bestSim = -1;
    for (const row of existing) {
      const sim = cosine(bufToFloatArr(row.embedding), input.embedding);
      if (sim > bestSim) {
        bestSim = sim;
        bestId = row.id;
      }
    }
    if (bestSim >= DEDUPE_THRESHOLD) {
      await events.emit({
        kind: 'frontier.dedupe',
        layer: 'L4',
        payload: {
          matchedId: bestId,
          similarity: Number(bestSim.toFixed(4)),
          question: input.question.slice(0, 80),
        },
      });
      return null;
    }

    const result = db
      .prepare(
        `INSERT INTO frontier (question, score, status, parent_id, depth, embedding, created_at)
         VALUES (?, ?, 'pending', ?, ?, ?, ?)`,
      )
      .run(
        input.question,
        input.score,
        input.parentId ?? null,
        input.depth,
        floatArrToBuf(input.embedding),
        Date.now(),
      );
    const id = Number(result.lastInsertRowid);

    await events.emit({
      kind: 'frontier.push',
      layer: 'L4',
      payload: {
        id,
        question: input.question.slice(0, 80),
        score: Number(input.score.toFixed(4)),
        depth: input.depth,
        parentId: input.parentId ?? null,
      },
    });

    return id;
  },

  async pop(): Promise<FrontierRow | null> {
    // Synthesis-phase lock: refuse to pop new work when the run is winding down.
    if (getRunState() && phaseMachine.now() === 'synthesis') {
      return null;
    }
    const db = getDb();
    let popped: RawRow | null = null;
    db.transaction(() => {
      const row = db
        .query(
          `SELECT * FROM frontier WHERE status='pending' ORDER BY score DESC, id ASC LIMIT 1`,
        )
        .get() as RawRow | null;
      if (!row) return;
      const now = Date.now();
      db.prepare(`UPDATE frontier SET status='in-progress', processed_at=? WHERE id=?`).run(
        now,
        row.id,
      );
      popped = { ...row, status: 'in-progress', processed_at: now };
    })();

    if (!popped) return null;
    const r = popped as RawRow;
    await events.emit({
      kind: 'frontier.pop',
      layer: 'L4',
      payload: {
        id: r.id,
        question: r.question.slice(0, 80),
        score: Number(r.score.toFixed(4)),
        depth: r.depth,
      },
    });
    return rowToFrontier(r, true);
  },

  async markDone(id: number, outcome: DoneOutcome): Promise<void> {
    const db = getDb();
    db.prepare(`UPDATE frontier SET status='done' WHERE id=?`).run(id);
    await events.emit({
      kind: 'frontier.done',
      layer: 'L4',
      payload: { id, factsAdded: outcome.factsAdded, claimsExtracted: outcome.claimsExtracted },
    });
  },

  async markSkipped(id: number, reason: string): Promise<void> {
    const db = getDb();
    db.prepare(`UPDATE frontier SET status='skipped' WHERE id=?`).run(id);
    await events.emit({
      kind: 'frontier.skip',
      layer: 'L4',
      payload: { id, reason },
    });
  },

  listPending(limit = 5): FrontierRow[] {
    const db = getDb();
    const rows = db
      .query(
        `SELECT id, question, score, status, parent_id, depth, created_at, processed_at
         FROM frontier WHERE status='pending' ORDER BY score DESC LIMIT ?`,
      )
      .all(limit) as RawRow[];
    return rows.map((r) => rowToFrontier(r, false));
  },

  listAll(): FrontierRow[] {
    const db = getDb();
    const rows = db
      .query(
        `SELECT id, question, score, status, parent_id, depth, created_at, processed_at
         FROM frontier ORDER BY id ASC`,
      )
      .all() as RawRow[];
    return rows.map((r) => rowToFrontier(r, false));
  },

  count(): number {
    return (getDb().query('SELECT COUNT(*) AS n FROM frontier').get() as { n: number }).n;
  },

  /** Read all embeddings (no other columns) — used by the proposer's novelty check. */
  allEmbeddings(): Float32Array[] {
    const db = getDb();
    const rows = db.query('SELECT embedding FROM frontier').all() as Array<{
      embedding: Buffer | Uint8Array;
    }>;
    return rows.map((r) => bufToFloatArr(r.embedding));
  },
};
