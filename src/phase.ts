/**
 * Phase machine + deadline parser + run-state singleton.
 *
 * The phase is derived purely from `Date.now()` against `started_at` and
 * `deadline_at`. We cache the last-observed phase in memory so we emit one
 * `phase.transition` event per real transition (not per check).
 */

import { getDb } from './db.ts';
import { events } from './events.ts';
import { embedder } from './embed.ts';
import { draftContract, type ResearchContract } from './contract.ts';

export type Phase = 'breadth' | 'depth' | 'synthesis';

export const BREADTH_END = 0.30;
export const DEPTH_END = 0.80;
export const MIN_DEADLINE_MS = 60_000;

export type RunState = {
  task: string;
  startedAt: number;
  deadlineAt: number;
  phase: Phase | 'done';
  contract: ResearchContract | null;
  taskEmbedding: Float32Array | null;
};

let lastSeenPhase: Phase | null = null;

function progressToPhase(progress: number): Phase {
  if (progress < BREADTH_END) return 'breadth';
  if (progress < DEPTH_END) return 'depth';
  return 'synthesis';
}

/**
 * Parse a deadline string into a unix-ms timestamp. Accepts `Ns`, `Nm`, `Nh`,
 * `Nms`, or ISO-8601. Throws on past, garbage, or `< now + MIN_DEADLINE_MS`.
 */
export function parseDeadline(input: string, now: number): number {
  const s = input.trim();

  // Duration pattern: 30s, 90m, 5h, 500ms.
  const m = s.match(/^(\d+(?:\.\d+)?)(ms|s|m|h)$/i);
  let target: number;
  if (m) {
    const n = Number(m[1]);
    const unit = m[2]!.toLowerCase();
    const mult = unit === 'ms' ? 1 : unit === 's' ? 1000 : unit === 'm' ? 60_000 : 3_600_000;
    target = now + n * mult;
  } else {
    const t = Date.parse(s);
    if (Number.isNaN(t)) {
      throw new Error(
        `parseDeadline: cannot parse "${input}" — use a duration (30s/5m/2h/500ms) or ISO-8601 timestamp`,
      );
    }
    target = t;
  }

  if (target <= now) {
    throw new Error(`parseDeadline: deadline is in the past (must be in the future)`);
  }
  if (target - now < MIN_DEADLINE_MS) {
    throw new Error(
      `parseDeadline: deadline too near (minimum ${MIN_DEADLINE_MS / 1000}s from now)`,
    );
  }
  return target;
}

type RawRow = {
  id: number;
  task: string;
  started_at: number;
  deadline_at: number;
  phase: string;
  contract_json: string | null;
  task_embedding: Buffer | Uint8Array | null;
};

function decodeContract(json: string | null): ResearchContract | null {
  if (!json) return null;
  try {
    const obj = JSON.parse(json) as Partial<ResearchContract>;
    if (typeof obj.core_question !== 'string' || !Array.isArray(obj.out_of_scope)) return null;
    return {
      core_question: obj.core_question,
      sub_questions: Array.isArray(obj.sub_questions) ? obj.sub_questions : [],
      good_answer_contains: Array.isArray(obj.good_answer_contains) ? obj.good_answer_contains : [],
      out_of_scope: obj.out_of_scope,
    };
  } catch {
    return null;
  }
}

function decodeEmbedding(buf: Buffer | Uint8Array | null): Float32Array | null {
  if (!buf) return null;
  const out = new Float32Array(buf.byteLength / 4);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  for (let i = 0; i < out.length; i++) out[i] = view.getFloat32(i * 4, true);
  return out;
}

export function getRunState(): RunState | null {
  const db = getDb();
  const row = db.query('SELECT * FROM run_state WHERE id=1').get() as RawRow | null;
  if (!row) return null;
  return {
    task: row.task,
    startedAt: row.started_at,
    deadlineAt: row.deadline_at,
    phase: row.phase as Phase | 'done',
    contract: decodeContract(row.contract_json),
    taskEmbedding: decodeEmbedding(row.task_embedding),
  };
}

/**
 * Begin a new run. Replaces any prior singleton row, resets the in-memory
 * phase cache, emits one `run.start` event.
 */
export async function runStart(task: string, deadlineAt: number): Promise<void> {
  const db = getDb();
  const startedAt = Date.now();
  db.prepare(
    `INSERT OR REPLACE INTO run_state (id, task, started_at, deadline_at, phase)
     VALUES (1, ?, ?, ?, 'breadth')`,
  ).run(task, startedAt, deadlineAt);
  lastSeenPhase = 'breadth';
  await events.emit({
    kind: 'run.start',
    layer: 'L5',
    payload: {
      task: task.slice(0, 120),
      deadlineAt,
      durationMs: deadlineAt - startedAt,
    },
  });

  // Cache the task embedding on run_state for the L3 relevance gate.
  const [taskEmbedding] = await embedder.embed([task]);
  if (taskEmbedding) {
    db.prepare('UPDATE run_state SET task_embedding = ? WHERE id = 1').run(
      Buffer.from(taskEmbedding.buffer, taskEmbedding.byteOffset, taskEmbedding.byteLength),
    );
  }

  // Draft the research contract. Failures return an empty contract (no out-of-scope items);
  // the gate degrades to plain task cosine but the run continues.
  const contract = await draftContract(task);
  db.prepare('UPDATE run_state SET contract_json = ? WHERE id = 1').run(JSON.stringify(contract));
}

export type RunEndStats = {
  iterations: number;
  factsAdded: number;
  claimsExtracted: number;
  questionsSeeded?: number;
  questionsProposed?: number;
  proposalsDeduped?: number;
  pendingRemaining?: number;
  phaseReached: Phase;
};

export async function runEnd(stats: RunEndStats): Promise<void> {
  const db = getDb();
  const state = getRunState();
  const elapsedMs = state ? Date.now() - state.startedAt : 0;
  db.prepare(`UPDATE run_state SET phase='done' WHERE id=1`).run();
  await events.emit({
    kind: 'run.end',
    layer: 'L5',
    payload: {
      ...stats,
      elapsedMs,
    },
  });
}

export const phaseMachine = {
  /**
   * Compute the current phase from the active run's clock. Throws if no run
   * is active. Emits `phase.transition` once per genuine transition.
   */
  now(): Phase {
    const state = getRunState();
    if (!state) {
      throw new Error('phaseMachine.now: no active run (call runStart first)');
    }
    if (state.phase === 'done') return 'synthesis';

    const total = state.deadlineAt - state.startedAt;
    const elapsed = Date.now() - state.startedAt;
    const progress = total > 0 ? Math.min(1, elapsed / total) : 1;
    const current = progressToPhase(progress);

    if (lastSeenPhase !== current) {
      // Walk through any phases we skipped (e.g. breadth → synthesis directly
      // when a long step spanned the depth window) so the event log narrates
      // every boundary, even ones no observer was around to notice.
      const order: Phase[] = ['breadth', 'depth', 'synthesis'];
      const fromIdx = order.indexOf(lastSeenPhase ?? 'breadth');
      const toIdx = order.indexOf(current);
      let cursor = lastSeenPhase ?? 'breadth';
      for (let i = fromIdx + 1; i <= toIdx; i++) {
        const next = order[i]!;
        void events.emit({
          kind: 'phase.transition',
          layer: 'L5',
          payload: { from: cursor, to: next, elapsedMs: elapsed },
        });
        cursor = next;
      }
      lastSeenPhase = current;
      try {
        getDb().prepare(`UPDATE run_state SET phase=? WHERE id=1`).run(current);
      } catch {
        // Telemetry-grade — ignore
      }
    }
    return current;
  },

  /** Reset in-memory cache (used by tests; not used at runtime). */
  resetCache(): void {
    lastSeenPhase = null;
  },
};

/**
 * Seed the in-memory `lastSeenPhase` cache without emitting a `phase.transition`
 * event. Used by L7 resume so the first `phaseMachine.now()` call after pickup
 * doesn't fire a phantom transition from the default cache state.
 */
export function seedPhaseCache(phase: Phase): void {
  lastSeenPhase = phase;
}
