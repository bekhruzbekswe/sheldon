/**
 * Append-only JSONL event log.
 *
 * Every action across every layer of Sheldon emits one event here.
 * The kind taxonomy is a closed string-literal union so misspelled kinds
 * are caught at compile time. Add new kinds as new layers ship.
 *
 * Emit is non-throwing: if the disk write fails, we log to stderr and
 * return — the agent's main loop must not die because telemetry failed.
 */

import { mkdirSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export type EventKind =
  | 'llm.fast'
  | 'llm.deep'
  | 'search.query'
  | 'scrape.fetch'
  | 'scrape.skip'
  | 'summary.write'
  | 'chunk.split'
  | 'embed.batch'
  | 'claim.extract'
  | 'fact.write'
  | 'fact.dedupe'
  | 'frontier.seed'
  | 'frontier.push'
  | 'frontier.dedupe'
  | 'frontier.pop'
  | 'frontier.done'
  | 'frontier.skip'
  | 'iteration.start'
  | 'iteration.end'
  | 'phase.transition'
  | 'run.start'
  | 'run.end'
  | 'cluster.computed'
  | 'section.written'
  | 'report.written'
  | 'resume.detected'
  | 'resume.applied';

export type Layer = 'L0' | 'L1' | 'L2' | 'L3' | 'L4' | 'L5' | 'L6' | 'L7' | 'L8';

export type Event = {
  ts: string;
  kind: EventKind;
  layer: Layer;
  durationMs?: number;
  payload: unknown;
};

export type EmitInput = {
  kind: EventKind;
  layer: Layer;
  durationMs?: number;
  payload?: unknown;
};

const LOG_PATH = '.sheldon/events.jsonl';
let dirEnsured = false;

function ensureDir() {
  if (dirEnsured) return;
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true });
    dirEnsured = true;
  } catch (err) {
    console.error(`[events] could not create log directory: ${(err as Error).message}`);
  }
}

async function append(line: string) {
  ensureDir();
  // O_APPEND is line-atomic on macOS for writes ≤ PIPE_BUF (4KB), which our
  // single-line events comfortably satisfy.
  await appendFile(LOG_PATH, line, 'utf8');
}

export const events = {
  async emit(input: EmitInput): Promise<void> {
    const event: Event = {
      ts: new Date().toISOString(),
      kind: input.kind,
      layer: input.layer,
      ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
      payload: input.payload ?? {},
    };
    try {
      await append(JSON.stringify(event) + '\n');
    } catch (err) {
      console.error(`[events] write failed: ${(err as Error).message}`);
    }
  },
};

export const EVENT_LOG_PATH = LOG_PATH;
