/**
 * L7 resume + crash recovery.
 *
 * Detection: a run is "interrupted" if `run_state.phase != 'done'` and we're
 * within the 24h grace window after `deadline_at`. Stale runs are ignored.
 *
 * Reset: any frontier rows still `in-progress` at startup time were popped
 * before the crash but never marked done/skipped. Reset them to `pending`
 * so the resumed loop can re-pop and retry.
 *
 * Clear: --fresh wipes everything except `.sheldon/reports/` (past reports
 * are valuable historical artifacts).
 */

import { unlink } from 'node:fs/promises';
import { getDb } from './db.ts';
import { getRunState, type RunState } from './phase.ts';

const GRACE_MS = 24 * 3600 * 1000;

const FILES_TO_CLEAR = [
  '.sheldon/sheldon.db',
  '.sheldon/sheldon.db-wal',
  '.sheldon/sheldon.db-shm',
  '.sheldon/events.jsonl',
  '.sheldon/last-summary.md',
];

export function detectInterruptedRun(): RunState | null {
  const state = getRunState();
  if (!state) return null;
  if (state.phase === 'done') return null;
  if (Date.now() > state.deadlineAt + GRACE_MS) return null;
  return state;
}

export function resetInProgressFrontier(): number {
  const db = getDb();
  const result = db
    .prepare(`UPDATE frontier SET status='pending' WHERE status='in-progress'`)
    .run();
  return Number(result.changes);
}

export async function clearAll(): Promise<void> {
  for (const path of FILES_TO_CLEAR) {
    try {
      await unlink(path);
    } catch {
      // missing → fine
    }
  }
}

export const RESUME_GRACE_MS = GRACE_MS;
