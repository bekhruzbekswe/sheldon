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
 * Clear: --fresh resets the run-scoped tables (facts, frontier, run_state)
 * and the side-channel files. The `sources` classifier cache is intentionally
 * preserved — it's a cross-run cache, paying re-classification cost on every
 * --fresh would be wasteful. Past reports under `.sheldon/reports/` are also
 * preserved.
 */

import { unlink } from 'node:fs/promises';
import { getDb } from './db.ts';
import { getRunState, type RunState } from './phase.ts';

const GRACE_MS = 24 * 3600 * 1000;

const SIDE_CHANNEL_FILES_TO_CLEAR = [
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
  // Per-table DELETE preserves the `sources` classifier cache and keeps the DB file
  // vnode stable (the dashboard's open handle survives without SQLITE_IOERR_VNODE).
  try {
    const db = getDb();
    db.exec('BEGIN; DELETE FROM facts; DELETE FROM frontier; DELETE FROM run_state; COMMIT;');
  } catch {
    // DB file or tables missing — fine, nothing to clear.
  }
  for (const path of SIDE_CHANNEL_FILES_TO_CLEAR) {
    try {
      await unlink(path);
    } catch {
      // missing → fine
    }
  }
}

export const RESUME_GRACE_MS = GRACE_MS;
